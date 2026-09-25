import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { z, ZodError } from "zod";
import { config } from "../config";
import { db } from "../db/client";
import { requireCapability } from "../auth/capabilities";
import { auditRequest } from "../auth/audit";
import { createUser, listUsers, resetPassword, updateUser, type AuditActor } from "../auth/identity-service";
import { createFullBackup, positiveInteger, restoreFullBackup } from "../services/backup-service";
import { verifyRestoredEnvironment } from "../services/restore-verification";
import { managedKeyPath } from "../security/key-store";
import { captureCatalog } from "../services/knowledge/knowledge-sync-service";
import type { AuditEvent } from "../../shared/types";
import { bindJobPlatform, createPlatform, disablePlatform, getPlatform, listJobs, listPlatforms, restorePlatform, updatePlatform } from "../db/repositories";
import { createRouteResponders } from "../http/route-response";

const roleSchema = z.enum(["admin", "config", "operator", "reviewer", "readonly"]);

const createUserSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(8).max(512),
  displayName: z.string().trim().min(1).max(100),
  role: roleSchema,
}).strict();

const updateUserSchema = z.object({
  isEnabled: z.boolean().optional(),
  role: roleSchema.optional(),
  displayName: z.string().trim().min(1).max(100).optional(),
}).strict();

const resetPasswordSchema = z.object({ password: z.string().min(8).max(512) }).strict();

const auditQuerySchema = z.object({
  action: z.string().min(1).max(120).optional(),
  actorUserId: z.string().min(1).max(200).optional(),
  targetType: z.string().min(1).max(120).optional(),
  targetId: z.string().min(1).max(200).optional(),
  outcome: z.enum(["success", "failure"]).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().min(1).max(300).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
}).strict();

const restoreSchema = z.object({
  name: z.string().min(1).max(300).refine((value) => path.basename(value) === value, "备份名称无效"),
  targetDir: z.string().min(1).max(1000),
}).strict();

const backupNameSchema = z.object({
  name: z.string().min(1).max(300).refine((value) => path.basename(value) === value, "备份名称无效"),
}).strict();

const verifySchema = z.object({
  targetDir: z.string().min(1).max(1000),
}).strict();

const platformCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(1).max(60),
}).strict();

const platformUpdateSchema = platformCreateSchema.partial().refine((value) => Object.keys(value).length > 0, "至少修改一项");

const platformBackfillSchema = z.object({
  platformId: z.string().min(1).max(200),
  reason: z.string().trim().min(1).max(500),
}).strict();

function actorFrom(req: express.Request): AuditActor {
  return {
    id: req.currentUser?.id,
    display: req.currentUser?.displayName ?? "系统",
    correlationId: req.correlationId,
  };
}

function backupRoot() {
  return path.join(config.dataDir, "backups");
}

function listBackups() {
  const root = backupRoot();
  if (!fs.existsSync(root)) return [];
  const items: Array<{ name: string; createdAt: string | null; valid: boolean }> = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("full-")) continue;
    let createdAt: string | null = null;
    let valid = false;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, entry.name, "manifest.json"), "utf8")) as { createdAt?: string };
      createdAt = typeof manifest.createdAt === "string" ? manifest.createdAt : null;
      valid = createdAt !== null;
    } catch {
      valid = false;
    }
    items.push({ name: entry.name, createdAt, valid });
  }
  return items.sort((left, right) => (right.createdAt ?? right.name).localeCompare(left.createdAt ?? left.name));
}

function busyWithWork() {
  return Boolean(
    db.prepare("SELECT id FROM jobs WHERE run_token IS NOT NULL LIMIT 1").get()
    || db.prepare("SELECT id FROM records WHERE status = 'processing' LIMIT 1").get()
    || db.prepare("SELECT id FROM import_jobs WHERE status IN ('queued','processing') LIMIT 1").get(),
  );
}

export function createAdminRouter(): express.Router {
  const router = express.Router();
  const usersRead = requireCapability("user:manage", "user.list", "user");
  const usersWrite = requireCapability("user:manage", "user.manage", "user");
  const auditRead = requireCapability("audit:view", "audit.query", "audit_event");
  const backupRead = requireCapability("backup:manage", "backup.list", "backup");
  const backupCreate = requireCapability("backup:manage", "backup.create", "backup");
  const backupRestore = requireCapability("backup:manage", "backup.restore", "backup");
  const backupVerify = requireCapability("backup:manage", "backup.verify", "backup");
  const backupDrill = requireCapability("backup:manage", "backup.drill", "backup");
  const platformRead = requireCapability("config:manage", "platform.list", "platform");
  const platformWrite = requireCapability("config:manage", "platform.manage", "platform");

  const { ok, fail } = createRouteResponders({
    resolveMessage: (error) => (
      error instanceof ZodError
        ? "请求参数无效"
        : error instanceof Error
          ? error.message
          : "请求失败"
    ),
  });

  router.get("/users", usersRead, (_req, res) => ok(res, listUsers()));

  router.get("/platforms", platformRead, (_req, res) => ok(res, listPlatforms(true)));

  router.post("/platforms", platformWrite, (req, res) => {
    try {
      const platform = createPlatform(platformCreateSchema.parse(req.body));
      auditRequest(req, { action: "config.platform_create", targetType: "platform", targetId: platform.id, metadata: { code: platform.code, name: platform.name } });
      return ok(res, platform);
    } catch (error) { return fail(res, error); }
  });

  router.patch("/platforms/:id", platformWrite, (req, res) => {
    try {
      const platform = updatePlatform(req.params.id, platformUpdateSchema.parse(req.body));
      auditRequest(req, { action: "config.platform_update", targetType: "platform", targetId: platform.id, metadata: { code: platform.code, name: platform.name } });
      return ok(res, platform);
    } catch (error) { return fail(res, error); }
  });

  router.post("/platforms/:id/disable", platformWrite, (req, res) => {
    try {
      const platform = disablePlatform(req.params.id);
      auditRequest(req, { action: "config.platform_disable", targetType: "platform", targetId: platform.id, metadata: { code: platform.code } });
      return ok(res, platform);
    } catch (error) { return fail(res, error); }
  });

  router.post("/platforms/:id/restore", platformWrite, (req, res) => {
    try {
      const platform = restorePlatform(req.params.id);
      auditRequest(req, { action: "config.platform_restore", targetType: "platform", targetId: platform.id, metadata: { code: platform.code } });
      return ok(res, platform);
    } catch (error) { return fail(res, error); }
  });

  router.get("/platform-backfill-candidates", platformRead, (_req, res) => ok(res, listJobs().filter((job) => !job.platformId)));

  router.post("/jobs/:id/platform-backfill", platformWrite, (req, res) => {
    try {
      const input = platformBackfillSchema.parse(req.body);
      const platform = getPlatform(input.platformId);
      if (!platform) throw new Error("平台不存在");
      const job = bindJobPlatform(req.params.id, platform.id);
      auditRequest(req, {
        action: "task.platform_backfill",
        targetType: "job",
        targetId: job.id,
        metadata: { platformId: platform.id, platformCode: platform.code, reason: input.reason },
      });
      return ok(res, job);
    } catch (error) { return fail(res, error); }
  });

  router.post("/users", usersWrite, (req, res) => {
    try {
      const input = createUserSchema.parse(req.body);
      const user = createUser({ ...input, actor: actorFrom(req) });
      return ok(res, user);
    } catch (error) { return fail(res, error); }
  });

  router.patch("/users/:id", usersWrite, (req, res) => {
    try {
      const patch = updateUserSchema.parse(req.body);
      const user = updateUser(req.params.id, patch, actorFrom(req));
      return ok(res, user);
    } catch (error) { return fail(res, error); }
  });

  router.post("/users/:id/reset-password", usersWrite, (req, res) => {
    try {
      const input = resetPasswordSchema.parse(req.body);
      const user = resetPassword(req.params.id, input.password, actorFrom(req));
      return ok(res, user);
    } catch (error) { return fail(res, error); }
  });

  router.get("/audit-events", auditRead, (req, res) => {
    try {
      const filters = auditQuerySchema.parse(req.query);
      const limit = filters.limit ?? 50;
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (filters.action) { conditions.push("action = ?"); params.push(filters.action); }
      if (filters.actorUserId) { conditions.push("actor_user_id = ?"); params.push(filters.actorUserId); }
      if (filters.targetType) { conditions.push("target_type = ?"); params.push(filters.targetType); }
      if (filters.targetId) { conditions.push("target_id = ?"); params.push(filters.targetId); }
      if (filters.outcome) { conditions.push("outcome = ?"); params.push(filters.outcome); }
      if (filters.from) { conditions.push("occurred_at >= ?"); params.push(filters.from); }
      if (filters.to) { conditions.push("occurred_at <= ?"); params.push(filters.to); }
      if (filters.cursor) {
        const [occurredAt, rowid] = filters.cursor.split("::");
        if (!occurredAt || !rowid || !/^\d+$/.test(rowid)) throw new Error("分页游标无效");
        conditions.push("(occurred_at < ? OR (occurred_at = ? AND rowid < ?))");
        params.push(occurredAt, occurredAt, Number(rowid));
      }
      const rows = db.prepare(`SELECT rowid AS seq, * FROM audit_events
        ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY occurred_at DESC, rowid DESC LIMIT ?`).all(...params, limit) as Array<Record<string, any>>;
      const items: AuditEvent[] = rows.map((row) => ({
        id: row.id,
        actorUserId: row.actor_user_id ?? null,
        actorDisplay: row.actor_display,
        action: row.action,
        targetType: row.target_type ?? null,
        targetId: row.target_id ?? null,
        outcome: row.outcome,
        metadata: JSON.parse(row.metadata_json),
        correlationId: row.correlation_id ?? null,
        occurredAt: row.occurred_at,
      }));
      const last = rows.at(-1);
      return ok(res, { items, limit, nextCursor: rows.length === limit && last ? `${last.occurred_at}::${last.seq}` : null });
    } catch (error) { return fail(res, error); }
  });

  router.get("/backups", backupRead, (_req, res) => ok(res, listBackups()));

  router.post("/backups", backupCreate, async (req, res) => {
    try {
      if (busyWithWork()) return fail(res, "存在运行中或未恢复的任务，请稍后再备份", 409);
      const retention = positiveInteger(process.env.BACKUP_RETENTION, "BACKUP_RETENTION", 7);
      const result = await createFullBackup({
        database: db,
        backupRoot: backupRoot(),
        exportsDir: path.join(config.dataDir, "exports"),
        retention,
        catalog: captureCatalog,
      });
      const name = path.basename(result.directory);
      auditRequest(req, {
        action: "backup.create",
        targetType: "backup",
        targetId: name,
        metadata: { files: result.files, references: result.references, verified: result.verified },
      });
      return ok(res, {
        name,
        files: result.files,
        references: result.references,
        verified: result.verified,
        warnings: result.warnings,
      });
    } catch (error) { return fail(res, error); }
  });

  router.post("/backups/restore", backupRestore, async (req, res) => {
    try {
      const input = restoreSchema.parse(req.body);
      const root = path.resolve(backupRoot());
      const source = path.resolve(root, input.name);
      if (!source.startsWith(root + path.sep) || !fs.existsSync(source)) throw new Error("备份不存在");
      const target = path.resolve(input.targetDir);
      const dataDir = path.resolve(config.dataDir);
      if (target === dataDir || target.startsWith(dataDir + path.sep)) throw new Error("恢复目录必须位于运行数据目录之外");
      const result = await restoreFullBackup(source, target);
      auditRequest(req, {
        action: "backup.restore",
        targetType: "backup",
        targetId: input.name,
        metadata: { files: result.files, verified: result.verified },
      });
      return ok(res, result);
    } catch (error) { return fail(res, error); }
  });

  router.post("/backups/verify", backupVerify, (req, res) => {
    try {
      const input = verifySchema.parse(req.body);
      const target = path.resolve(input.targetDir);
      const dataDir = path.resolve(config.dataDir);
      if (target === dataDir || target.startsWith(dataDir + path.sep)) throw new Error("验证目录必须位于运行数据目录之外");
      const result = verifyRestoredEnvironment(target, { externalKey: process.env.ENCRYPTION_KEY });
      auditRequest(req, {
        action: "backup.verify",
        outcome: result.ok ? "success" : "failure",
        targetType: "backup_restore",
        targetId: path.basename(target),
        metadata: { ok: result.ok, checks: result.checks.map((check) => check.name) },
      });
      return ok(res, result);
    } catch (error) { return fail(res, error); }
  });

  router.post("/backups/drill", backupDrill, async (req, res) => {
    let target = "";
    try {
      const input = backupNameSchema.parse(req.body);
      const root = path.resolve(backupRoot());
      const source = path.resolve(root, input.name);
      if (!source.startsWith(root + path.sep) || !fs.existsSync(source)) throw new Error("备份不存在");
      target = path.join(os.tmpdir(), `customer-chat-analysis-restore-drill-${crypto.randomUUID()}`);
      await restoreFullBackup(source, target);
      const liveKey = managedKeyPath(config.databasePath);
      if (fs.existsSync(liveKey)) {
        const restoredKey = managedKeyPath(path.join(target, "data", "app.db"));
        await fs.promises.mkdir(path.dirname(restoredKey), { recursive: true });
        await fs.promises.copyFile(liveKey, restoredKey);
      }
      const result = verifyRestoredEnvironment(target, { externalKey: process.env.ENCRYPTION_KEY });
      auditRequest(req, {
        action: "backup.drill",
        outcome: result.ok ? "success" : "failure",
        targetType: "backup",
        targetId: input.name,
        metadata: { ok: result.ok, checks: result.checks.map((check) => check.name) },
      });
      return ok(res, { backup: input.name, ok: result.ok, checks: result.checks });
    } catch (error) {
      return fail(res, error);
    } finally {
      const prefix = path.join(os.tmpdir(), "customer-chat-analysis-restore-drill-");
      if (target.startsWith(prefix)) await fs.promises.rm(target, { recursive: true, force: true });
    }
  });

  return router;
}
