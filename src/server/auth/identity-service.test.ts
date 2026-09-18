import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, initDb } from "../db/client";
import {
  bootstrapFirstAdmin,
  createSession,
  createUser,
  hasAnyUser,
  listUsers,
  resetPassword,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  setUserEnabled,
  singleOrganizationId,
  verifyCredentials,
} from "./identity-service";
import { hashPassword, verifyPassword } from "./passwords";

const ADMIN = { username: "root", password: "correct-horse-battery", displayName: "根管理员" };

function resetIdentityData() {
  db.exec("DELETE FROM user_sessions; DELETE FROM users;");
}

function seedAdmin() {
  db.exec("DELETE FROM user_sessions; DELETE FROM users;");
  return bootstrapFirstAdmin(ADMIN);
}

function activeSessions(userId: string) {
  return (db.prepare("SELECT id FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL").all(userId) as Array<{ id: string }>).length;
}

beforeAll(() => initDb());
beforeEach(() => resetIdentityData());

describe("password hashing", () => {
  it("stores only a salted slow hash and never the plain password", () => {
    const hash = hashPassword("secret-password");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("secret-password");
    expect(hashPassword("secret-password")).not.toBe(hash);
    expect(verifyPassword("secret-password", hash)).toBe(true);
    expect(verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("rejects malformed stored hashes without throwing", () => {
    for (const stored of ["", "plain", "scrypt$1$1$1$x$y$z", "scrypt$0$0$0$xxxx$x$y"]) {
      expect(verifyPassword("anything", stored)).toBe(false);
    }
  });
});

describe("first administrator bootstrap", () => {
  it("creates one admin on a fresh system and closes the entry for later calls", () => {
    const user = bootstrapFirstAdmin(ADMIN);
    expect(user).toMatchObject({ username: ADMIN.username, role: "admin", isEnabled: true });
    expect(JSON.stringify(user)).not.toContain("password_hash");
    expect(listUsers()).toHaveLength(1);
    expect(() => bootstrapFirstAdmin({ username: "second", password: "another-password-1" })).toThrow("已失效");
    expect(listUsers()).toHaveLength(1);
  });

  it("validates username and password policies before creating anything", () => {
    expect(() => bootstrapFirstAdmin({ username: "bad name!", password: "valid-password-1" })).toThrow("用户名");
    expect(() => bootstrapFirstAdmin({ username: "ok-user", password: "short" })).toThrow("密码");
    expect(hasAnyUser()).toBe(false);
  });
});

describe("credentials and sessions", () => {
  it("returns the user on a successful login and null on wrong password", () => {
    seedAdmin();
    const ok = verifyCredentials(ADMIN.username, ADMIN.password);
    expect(ok.user).toMatchObject({ username: ADMIN.username, role: "admin" });
    expect(verifyCredentials(ADMIN.username, "wrong-password!").reason).toMatch(/用户名或密码错误/);
    expect(verifyCredentials("missing-user", "wrong-password!").reason).toMatch(/用户名或密码错误/);
  });

  it("resolves only active, unexpired sessions and revokes on logout", () => {
    const user = seedAdmin();
    const session = createSession(user.id, 60_000);
    expect(resolveSession(session.token)?.username).toBe(ADMIN.username);
    expect(resolveSession("non-existent-token")).toBeUndefined();
    expect(Boolean(revokeSession(session.token))).toBe(true);
    expect(resolveSession(session.token)).toBeUndefined();
  });

  it("stops serving sessions after an account is disabled or its password is reset", () => {
    const user = seedAdmin();
    createUser({ username: "second-admin", password: "second-admin-password-1", displayName: "备用管理员", role: "admin" });
    const first = createSession(user.id, 60_000);
    const second = createSession(user.id, 60_000);
    expect(activeSessions(user.id)).toBe(2);

    setUserEnabled(user.id, false);
    expect(resolveSession(first.token)).toBeUndefined();
    expect(resolveSession(second.token)).toBeUndefined();
    expect(activeSessions(user.id)).toBe(0);
    expect(verifyCredentials(ADMIN.username, ADMIN.password).reason).toMatch(/停用/);

    setUserEnabled(user.id, true);
    const beforeReset = createSession(user.id, 60_000);
    expect(resolveSession(beforeReset.token)?.username).toBe(ADMIN.username);
    resetPassword(user.id, "fresh-password-1");
    expect(resolveSession(beforeReset.token)).toBeUndefined();
    expect(verifyCredentials(ADMIN.username, ADMIN.password).reason).toMatch(/用户名或密码错误/);
    expect(verifyCredentials(ADMIN.username, "fresh-password-1").user).toBeTruthy();
  });

  it("does not serve expired sessions and clears them lazily", () => {
    const user = seedAdmin();
    const session = createSession(user.id, 60_000);
    const row = db.prepare("SELECT token_hash, user_id FROM user_sessions WHERE user_id = ? LIMIT 1")
      .get(user.id) as { token_hash: string; user_id: string };
    db.prepare("UPDATE user_sessions SET expires_at = ? WHERE token_hash = ?")
      .run(new Date(Date.now() - 1000).toISOString(), row.token_hash);
    expect(resolveSession(session.token)).toBeUndefined();
    expect(db.prepare("SELECT revoked_at FROM user_sessions WHERE token_hash = ?").get(row.token_hash)?.revoked_at).toBeTruthy();
  });

  it("creates users with a system-unassigned history and never exposes hashes on any projection", () => {
    const admin = seedAdmin();
    const operator = createUser({ username: "ops", password: "operator-password-1", displayName: "操作员", role: "operator", actor: { id: admin.id, display: admin.displayName } });
    expect(operator.role).toBe("operator");
    for (const profile of [operator, ...listUsers()]) {
      expect(JSON.stringify(profile)).not.toContain("password_hash");
      expect(JSON.stringify(profile)).not.toContain("must_change_password");
    }
    expect(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'identity.create_user' AND target_id = ?").get(operator.id).n).toBe(1);
    expect(activeSessions(admin.id)).toBe(0);
    expect(() => createUser({ username: "ops", password: "operator-password-1", displayName: "重复", role: "operator" })).toThrow();
  });

  it("records audit events with actor and action but no secrets", () => {
    seedAdmin();
    verifyCredentials(ADMIN.username, ADMIN.password);
    verifyCredentials(ADMIN.username, "wrong-password!");
    const events = db.prepare("SELECT action, outcome, metadata_json FROM audit_events WHERE actor_user_id IS NOT NULL ORDER BY occurred_at").all() as Array<{ action: string; outcome: string; metadata_json: string }>;
    expect(events.map((event) => event.action)).toEqual(expect.arrayContaining(["auth.login", "auth.login_failed"]));
    expect(events.map((event) => event.outcome)).toEqual(expect.arrayContaining(["success", "failure"]));
    for (const event of events) {
      expect(JSON.stringify(event)).not.toContain(ADMIN.password);
      expect(JSON.stringify(event)).not.toContain("password_hash");
    }
  });

  it("scopes sessions to the singleton organization", () => {
    expect(singleOrganizationId()).toBe("org-default");
    const user = seedAdmin();
    const session = createSession(user.id, 60_000);
    const actual = db.prepare("SELECT organization_id FROM user_sessions WHERE user_id = ?").get(user.id) as { organization_id: string } | undefined;
    expect(actual?.organization_id).toBe("org-default");
    expect(revokeAllSessions(user.id)).toBe(1);
    expect(resolveSession(session.token)).toBeUndefined();
  });
});