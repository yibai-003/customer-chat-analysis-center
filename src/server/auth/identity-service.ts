import crypto from "node:crypto";
import { db } from "../db/client";
import { hashPassword, verifyPassword } from "./passwords";
import { USER_ROLES, type UserRole, type UserProfile } from "../../shared/types";

const ORG_ID = "org-default";

export const AUTH_ERRORS = {
  NO_ADMIN: "系统尚未创建账号，请在主机上运行 npm run bootstrap:admin 完成首次引导",
  INVALID_CREDENTIALS: "用户名或密码错误",
  DISABLED: "账号已停用，请联系管理员",
  LOGIN_REQUIRED: "未登录或会话已失效",
  BOOTSTRAP_CLOSED: "系统已存在账号，管理员引导入口已失效",
} as const;

interface UserRow {
  id: string;
  organization_id: string;
  username: string;
  display_name: string;
  role: UserRole;
  is_enabled: number;
  password_hash: string;
  must_change_password: number;
  created_at: string;
  updated_at: string;
}

const now = () => new Date().toISOString();
const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

let dummyHashCache: string | undefined;
function dummyHash() {
  if (!dummyHashCache) dummyHashCache = hashPassword("timing-equalizer");
  return dummyHashCache;
}

export function singleOrganizationId(): string {
  return ORG_ID;
}

export function hasAnyUser(): boolean {
  return db.prepare("SELECT 1 FROM users LIMIT 1").get() !== undefined;
}

export function safeUser(row: UserRow): UserProfile {
  return {
    id: row.id,
    organizationId: row.organization_id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    isEnabled: row.is_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function findUserByUsername(username: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE organization_id = ? AND username = ?")
    .get(ORG_ID, username) as UserRow | undefined;
}

function getUserRow(id: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function validateUsername(username: string) {
  if (typeof username !== "string") throw new Error("用户名格式无效");
  const value = username.trim();
  if (value.length < 1 || value.length > 100) throw new Error("用户名长度必须为 1-100 个字符");
  if (!/^[\w.\-@]+$/.test(value)) throw new Error("用户名只能包含字母、数字和下划线、点、短横线、@");
  return value;
}

export function validateDisplayName(displayName: string) {
  const value = typeof displayName !== "string" ? "" : displayName.trim();
  if (value.length < 1 || value.length > 100) throw new Error("显示名称长度必须为 1-100 个字符");
  return value;
}

export function validatePassword(password: unknown, label = "密码") {
  if (typeof password !== "string" || password.length < 8 || password.length > 512) {
    throw new Error(`${label}长度必须为 8-512 个字符`);
  }
  for (let index = 0; index < password.length; index += 1) {
    const code = password.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) throw new Error(`${label}包含不支持的字符`);
  }
  return password;
}

export interface AuditInput {
  actorUserId?: string;
  actorDisplay: string;
  action: string;
  targetType?: string;
  targetId?: string;
  outcome: "success" | "failure";
  metadata?: Record<string, unknown>;
  correlationId?: string;
}

export function writeAudit(input: AuditInput) {
  db.prepare(`INSERT INTO audit_events
    (id, organization_id, actor_user_id, actor_display, action, target_type, target_id, outcome, metadata_json, correlation_id, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      crypto.randomUUID(),
      ORG_ID,
      input.actorUserId ?? null,
      input.actorDisplay,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.outcome,
      JSON.stringify(input.metadata ?? {}),
      input.correlationId ?? null,
      now(),
    );
}

/**
 * One-time, host-local bootstrap for the first administrator. Serves as the only
 * creation path on a fresh system and fails closed once any account exists.
 */
export function bootstrapFirstAdmin(input: { username: string; password: string; displayName?: string }) {
  if (hasAnyUser()) throw new Error(AUTH_ERRORS.BOOTSTRAP_CLOSED);
  const username = validateUsername(input.username);
  const password = validatePassword(input.password, "初始密码");
  const displayName = validateDisplayName(input.displayName ?? "管理员");
  const id = crypto.randomUUID();
  const timestamp = now();
  const hash = hashPassword(password);
  db.transaction(() => {
    db.prepare(`INSERT INTO users
      (id, organization_id, username, display_name, role, is_enabled, password_hash, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'admin', 1, ?, 0, ?, ?)`)
      .run(id, ORG_ID, username, displayName, hash, timestamp, timestamp);
    writeAudit({
      actorDisplay: "系统",
      action: "identity.bootstrap_admin",
      targetType: "user",
      targetId: id,
      outcome: "success",
      metadata: { username },
    });
  })();
  return safeUser(getUserRow(id)!);
}

export interface AuditActor {
  id?: string;
  display: string;
  correlationId?: string;
}

const SYSTEM_ACTOR: AuditActor = { display: "系统" };

function assertAdminContinuity(user: UserRow, nextEnabled: boolean, nextRole: UserRole) {
  const currentlyAdmin = user.role === "admin" && user.is_enabled === 1;
  const willRemainAdmin = nextRole === "admin" && nextEnabled;
  if (!currentlyAdmin || willRemainAdmin) return;
  const remaining = db.prepare("SELECT COUNT(*) n FROM users WHERE id <> ? AND role = 'admin' AND is_enabled = 1")
    .get(user.id) as { n: number };
  if (remaining.n === 0) throw new Error("必须保留至少一个启用中的管理员");
}

export function createUser(input: { username: string; password: string; displayName: string; role: UserRole; actor?: AuditActor }) {
  const username = validateUsername(input.username);
  const password = validatePassword(input.password, "初始密码");
  const displayName = validateDisplayName(input.displayName);
  if (!USER_ROLES.includes(input.role)) throw new Error("角色无效");
  const actor = input.actor ?? SYSTEM_ACTOR;
  const id = crypto.randomUUID();
  const timestamp = now();
  const hash = hashPassword(password);
  db.transaction(() => {
    db.prepare(`INSERT INTO users
      (id, organization_id, username, display_name, role, is_enabled, password_hash, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?, ?)`)
      .run(id, ORG_ID, username, displayName, input.role, hash, timestamp, timestamp);
    writeAudit({
      actorUserId: actor.id,
      actorDisplay: actor.display,
      action: "identity.create_user",
      targetType: "user",
      targetId: id,
      outcome: "success",
      metadata: { username, role: input.role },
      correlationId: actor.correlationId,
    });
  })();
  return safeUser(getUserRow(id)!);
}

export function listUsers(): UserProfile[] {
  const rows = db.prepare("SELECT * FROM users ORDER BY created_at").all() as UserRow[];
  return rows.map(safeUser);
}

export function updateUser(
  userId: string,
  patch: { isEnabled?: boolean; role?: UserRole; displayName?: string },
  actor: AuditActor = SYSTEM_ACTOR,
) {
  const row = getUserRow(userId);
  if (!row) throw new Error("账号不存在");
  if (patch.role !== undefined && !USER_ROLES.includes(patch.role)) throw new Error("角色无效");
  const nextRole = patch.role ?? row.role;
  const nextEnabled = patch.isEnabled ?? row.is_enabled === 1;
  const nextDisplayName = patch.displayName === undefined ? row.display_name : validateDisplayName(patch.displayName);
  assertAdminContinuity(row, nextEnabled, nextRole);
  const changes: Record<string, unknown> = {};
  if (patch.role !== undefined && patch.role !== row.role) changes.role = patch.role;
  if (patch.isEnabled !== undefined && patch.isEnabled !== (row.is_enabled === 1)) changes.isEnabled = patch.isEnabled;
  if (patch.displayName !== undefined && nextDisplayName !== row.display_name) changes.displayName = nextDisplayName;
  if (!Object.keys(changes).length) return safeUser(row);
  db.transaction(() => {
    db.prepare("UPDATE users SET display_name = ?, role = ?, is_enabled = ?, updated_at = ? WHERE id = ?")
      .run(nextDisplayName, nextRole, nextEnabled ? 1 : 0, now(), userId);
    if (!nextEnabled) revokeAllSessions(userId);
    writeAudit({
      actorUserId: actor.id,
      actorDisplay: actor.display,
      action: "identity.update_user",
      targetType: "user",
      targetId: userId,
      outcome: "success",
      metadata: { username: row.username, changes },
      correlationId: actor.correlationId,
    });
  })();
  return safeUser(getUserRow(userId)!);
}

export function setUserEnabled(userId: string, enabled: boolean, actor: AuditActor = SYSTEM_ACTOR) {
  const row = getUserRow(userId);
  if (!row) throw new Error("账号不存在");
  assertAdminContinuity(row, enabled, row.role);
  db.transaction(() => {
    db.prepare("UPDATE users SET is_enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, now(), userId);
    if (!enabled) revokeAllSessions(userId);
    writeAudit({
      actorUserId: actor.id,
      actorDisplay: actor.display,
      action: enabled ? "identity.enable_user" : "identity.disable_user",
      targetType: "user",
      targetId: userId,
      outcome: "success",
      metadata: { username: row.username, enabled },
      correlationId: actor.correlationId,
    });
  })();
  return safeUser(getUserRow(userId)!);
}

export function resetPassword(userId: string, newPassword: string, actor: AuditActor = SYSTEM_ACTOR) {
  const row = getUserRow(userId);
  if (!row) throw new Error("账号不存在");
  const password = validatePassword(newPassword, "新密码");
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?")
      .run(hashPassword(password), now(), userId);
    revokeAllSessions(userId);
    writeAudit({
      actorUserId: actor.id,
      actorDisplay: actor.display,
      action: "identity.reset_password",
      targetType: "user",
      targetId: userId,
      outcome: "success",
      metadata: { username: row.username },
      correlationId: actor.correlationId,
    });
  })();
  return safeUser(getUserRow(userId)!);
}

/** Returns the user on success, or null with a reason for a 401/409 response. */
export function verifyCredentials(username: string, password: string, correlationId?: string): { user?: UserProfile; reason?: string } {
  const user = findUserByUsername(validateUsername(username));
  if (!user) {
    verifyPassword(password, dummyHash());
    writeAudit({
      actorDisplay: username,
      action: "auth.login_failed",
      targetType: "user",
      outcome: "failure",
      metadata: { reason: "no_such_user" },
      correlationId,
    });
    return { reason: AUTH_ERRORS.INVALID_CREDENTIALS };
  }
  if (user.is_enabled !== 1) {
    writeAudit({
      actorUserId: user.id,
      actorDisplay: user.display_name,
      action: "auth.login_blocked",
      targetType: "user",
      targetId: user.id,
      outcome: "failure",
      metadata: { reason: "disabled" },
      correlationId,
    });
    return { reason: AUTH_ERRORS.DISABLED };
  }
  if (!verifyPassword(password, user.password_hash)) {
    writeAudit({
      actorUserId: user.id,
      actorDisplay: user.display_name,
      action: "auth.login_failed",
      targetType: "user",
      targetId: user.id,
      outcome: "failure",
      metadata: { reason: "bad_password" },
      correlationId,
    });
    return { reason: AUTH_ERRORS.INVALID_CREDENTIALS };
  }
  writeAudit({
    actorUserId: user.id,
    actorDisplay: user.display_name,
    action: "auth.login",
    targetType: "user",
    targetId: user.id,
    outcome: "success",
    correlationId,
  });
  return { user: safeUser(user) };
}

export function createSession(userId: string, ttlMs: number): { token: string; expiresAt: string } {
  const user = getUserRow(userId);
  if (!user) throw new Error("账号不存在");
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare(`INSERT INTO user_sessions (id, organization_id, user_id, token_hash, created_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)`)
    .run(crypto.randomUUID(), ORG_ID, user.id, hashToken(token), now(), expiresAt);
  return { token, expiresAt };
}

export function revokeExpiredSessions() {
  db.prepare("UPDATE user_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND expires_at <= ?")
    .run(now(), now());
}

/** Resolves a raw cookie token to its user, revoking expired sessions lazily. */
export function resolveSession(token: string | undefined): UserProfile | undefined {
  if (!token) return undefined;
  revokeExpiredSessions();
  const row = db.prepare(`SELECT s.token_hash AS token_hash, u.* FROM user_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
    AND u.is_enabled = 1
    AND u.organization_id = ?`)
    .get(hashToken(token), now(), ORG_ID) as UserRow | undefined;
  return row ? safeUser(row) : undefined;
}

export function revokeSession(token: string, actorUserId?: string, correlationId?: string) {
  const row = db.prepare("SELECT id, user_id FROM user_sessions WHERE token_hash = ?")
    .get(hashToken(token)) as { id: string; user_id: string } | undefined;
  if (!row) return false;
  const current = db.prepare("SELECT id, username, display_name FROM users WHERE id = ?")
    .get(row.user_id) as { id: string; username: string; display_name: string } | undefined;
  db.transaction(() => {
    db.prepare("UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(now(), row.id);
    writeAudit({
      actorUserId: actorUserId ?? row.user_id,
      actorDisplay: current?.display_name ?? "用户",
      action: "auth.logout",
      targetType: "user",
      targetId: row.user_id,
      outcome: "success",
      metadata: { username: current?.username },
      correlationId,
    });
  })();
  return true;
}

export function revokeAllSessions(userId: string) {
  return db.prepare("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
    .run(now(), userId).changes;
}