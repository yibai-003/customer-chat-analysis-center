import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { db, initDb } from "../db/client";
import { bootstrapFirstAdmin, createUser } from "./identity-service";
import { upsertKnowledgeBase } from "../services/knowledge/knowledge-repository";
import type { UserRole } from "../../shared/types";

interface RoleAccount {
  username: string;
  password: string;
  displayName: string;
  role: UserRole;
}

const ACCOUNTS: RoleAccount[] = [
  { username: "admin", password: "test-password-123", displayName: "管理员", role: "admin" },
  { username: "config-user", password: "config-password-123", displayName: "配置人员", role: "config" },
  { username: "operator-user", password: "operator-password-123", displayName: "操作人员", role: "operator" },
  { username: "reviewer-user", password: "reviewer-password-123", displayName: "审核人员", role: "reviewer" },
  { username: "readonly-user", password: "readonly-password-123", displayName: "只读人员", role: "readonly" },
];

let server: Server;
let baseUrl: string;
let cookies: Record<string, string> = {};
const restoreTargets: string[] = [];

function resetIdentity() {
  db.exec("DELETE FROM user_sessions; DELETE FROM users;");
  const [admin, ...rest] = ACCOUNTS;
  bootstrapFirstAdmin({ username: admin.username, password: admin.password, displayName: admin.displayName });
  for (const account of rest) {
    createUser({
      username: account.username,
      password: account.password,
      displayName: account.displayName,
      role: account.role,
    });
  }
}

function resetConfiguration() {
  db.exec(`
    DELETE FROM model_usage_events;
    DELETE FROM model_configs;
    DELETE FROM model_providers;
    DELETE FROM knowledge_item_fts;
    DELETE FROM knowledge_items;
    DELETE FROM knowledge_bases WHERE id = 'cfg-base';
    DELETE FROM analysis_fields WHERE section_id LIKE 'cfg-%';
    DELETE FROM analysis_sections WHERE id LIKE 'cfg-%';
  `);
}

async function login(username: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`登录失败：${response.status}`);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

async function request(
  pathname: string,
  options: { cookie?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function cookieFor(role: string) {
  return cookies[role]!;
}

function userId(username: string) {
  return (db.prepare("SELECT id FROM users WHERE username = ?").get(username) as { id: string }).id;
}

function auditMarker() {
  return (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS marker FROM audit_events").get() as { marker: number }).marker;
}

function auditEvents(filter: { action?: string; targetId?: string; outcome?: string; since?: number }) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.since !== undefined) { conditions.push("rowid > ?"); params.push(filter.since); }
  if (filter.action) { conditions.push("action = ?"); params.push(filter.action); }
  if (filter.targetId) { conditions.push("target_id = ?"); params.push(filter.targetId); }
  if (filter.outcome) { conditions.push("outcome = ?"); params.push(filter.outcome); }
  return db.prepare(`SELECT * FROM audit_events ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY rowid`)
    .all(...params) as Array<{
      actor_user_id: string | null;
      actor_display: string;
      action: string;
      target_type: string | null;
      target_id: string | null;
      outcome: string;
      metadata_json: string;
      correlation_id: string | null;
    }>;
}

beforeAll(async () => {
  initDb();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  resetIdentity();
  resetConfiguration();
  cookies = {};
  for (const account of ACCOUNTS) cookies[account.role] = await login(account.username, account.password);
});

afterAll(async () => {
  for (const target of restoreTargets.splice(0)) fs.rmSync(target, { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), "configuration-admin-restore"), { recursive: true, force: true });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

describe("configuration, model pool, account and audit authorization", () => {
  it("limits account administration to administrators", async () => {
    expect((await request("/api/admin/users")).status).toBe(401);
    expect((await request("/api/admin/users", { cookie: cookieFor("admin") })).status).toBe(200);
    for (const role of ["config", "operator", "reviewer", "readonly"]) {
      expect((await request("/api/admin/users", { cookie: cookieFor(role) })).status, role).toBe(403);
      expect((await request("/api/admin/users", {
        cookie: cookieFor(role),
        method: "POST",
        body: { username: `created-by-${role}`, password: "created-password-1", displayName: "越权", role: "admin" },
      })).status, role).toBe(403);
    }
    expect(db.prepare("SELECT id FROM users WHERE username LIKE 'created-by-%'").get()).toBeUndefined();

    const created = await request("/api/admin/users", {
      cookie: cookieFor("admin"),
      method: "POST",
      body: { username: "new-operator", password: "new-operator-password-1", displayName: "新操作员", role: "operator" },
    });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ username: "new-operator", role: "operator", isEnabled: true });
    expect(JSON.stringify(created.body)).not.toContain("password");
    expect(JSON.stringify(created.body)).not.toContain("password_hash");

    const operatorCookie = await login("new-operator", "new-operator-password-1");
    expect((await request("/api/jobs", { cookie: operatorCookie })).status).toBe(200);

    const disabled = await request(`/api/admin/users/${created.body.data.id}`, {
      cookie: cookieFor("admin"),
      method: "PATCH",
      body: { isEnabled: false },
    });
    expect(disabled.status).toBe(200);
    expect((await request("/api/jobs", { cookie: operatorCookie })).status).toBe(401);
    expect((await request("/api/auth/login", {
      method: "POST",
      body: { username: "new-operator", password: "new-operator-password-1" },
    })).status).toBe(401);

    const reset = await request(`/api/admin/users/${created.body.data.id}/reset-password`, {
      cookie: cookieFor("admin"),
      method: "POST",
      body: { password: "reset-password-1" },
    });
    expect(reset.status).toBe(200);
    await request(`/api/admin/users/${created.body.data.id}`, {
      cookie: cookieFor("admin"),
      method: "PATCH",
      body: { isEnabled: true },
    });
    expect((await request("/api/auth/login", {
      method: "POST",
      body: { username: "new-operator", password: "new-operator-password-1" },
    })).status).toBe(401);
    expect((await request("/api/auth/login", {
      method: "POST",
      body: { username: "new-operator", password: "reset-password-1" },
    })).status).toBe(200);
  });

  it("prevents disabling or demoting the last enabled administrator", async () => {
    const adminId = userId("admin");
    const disable = await request(`/api/admin/users/${adminId}`, {
      cookie: cookieFor("admin"),
      method: "PATCH",
      body: { isEnabled: false },
    });
    expect(disable.status).toBe(400);
    expect(disable.body.error).toContain("至少一个启用中的管理员");
    const demote = await request(`/api/admin/users/${adminId}`, {
      cookie: cookieFor("admin"),
      method: "PATCH",
      body: { role: "config" },
    });
    expect(demote.status).toBe(400);
    expect(db.prepare("SELECT role, is_enabled FROM users WHERE id = ?").get(adminId)).toEqual({ role: "admin", is_enabled: 1 });
  });

  it("reserves configuration endpoints for configuration personnel and administrators", async () => {
    const sectionBody = { id: "cfg-section", name: "配置测试板块", prompt: "" };
    for (const role of ["operator", "reviewer", "readonly"]) {
      expect((await request("/api/sections", { cookie: cookieFor(role), method: "POST", body: sectionBody })).status, role).toBe(403);
      expect((await request("/api/model-configs", {
        cookie: cookieFor(role),
        method: "POST",
        body: { name: "cfg-model", baseUrl: "https://cfg.example/v1", apiKey: "cfg-secret-key-123", model: "cfg-model" },
      })).status, role).toBe(403);
      expect((await request("/api/sections/refund/knowledge-bases", { cookie: cookieFor(role) })).status, role).toBe(403);
    }
    expect(db.prepare("SELECT id FROM analysis_sections WHERE id = 'cfg-section'").get()).toBeUndefined();

    for (const role of ["config", "admin"]) {
      const created = await request("/api/sections", { cookie: cookieFor(role), method: "POST", body: sectionBody });
      expect(created.status, role).toBe(200);
      expect((await request("/api/sections/cfg-section", { cookie: cookieFor(role), method: "DELETE" })).status, role).toBe(200);
    }

    const model = await request("/api/model-configs", {
      cookie: cookieFor("config"),
      method: "POST",
      body: { name: "cfg-model", baseUrl: "https://cfg.example/v1", apiKey: "cfg-secret-key-123", model: "cfg-model" },
    });
    expect(model.status).toBe(200);
    expect(JSON.stringify(model.body)).not.toContain("cfg-secret-key-123");

    upsertKnowledgeBase({
      id: "cfg-base",
      sectionId: "refund",
      name: "配置测试库",
      originalFilename: "cfg.xlsx",
      columns: [{ name: "原因", roles: ["result", "search"] }],
      isEnabled: true,
    });
    const marker = auditMarker();
    const knowledgeItem = await request("/api/knowledge-bases/cfg-base/items", {
      cookie: cookieFor("config"),
      method: "POST",
      body: { values: { 原因: "配置测试条目" }, isEnabled: true },
    });
    expect(knowledgeItem.status).toBe(200);
    expect(auditEvents({ action: "config.knowledge_create_item", targetId: knowledgeItem.body.data.id, since: marker })).toHaveLength(1);
    expect((await request("/api/knowledge-bases/cfg-base/items", {
      cookie: cookieFor("readonly"),
      method: "POST",
      body: { values: { 原因: "越权写入" }, isEnabled: true },
    })).status).toBe(403);
  });

  it("requires explicit capabilities for high-impact model pool operations", async () => {
    const poolMarker = auditMarker();
    const provider = await request("/api/model-providers", {
      cookie: cookieFor("config"),
      method: "POST",
      body: { name: "配置服务商", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "pool-provider-secret" },
    });
    expect(provider.status).toBe(200);
    expect(JSON.stringify(provider.body)).not.toContain("pool-provider-secret");
    const providerId = provider.body.data.id;

    for (const role of ["operator", "reviewer", "readonly"]) {
      expect((await request("/api/model-providers", { cookie: cookieFor(role) })).status, role).toBe(403);
      expect((await request(`/api/model-providers/${providerId}`, {
        cookie: cookieFor(role),
        method: "PATCH",
        body: { apiKey: "rotated-secret" },
      })).status, role).toBe(403);
      expect((await request("/api/model-pool-members/verify", {
        cookie: cookieFor(role),
        method: "POST",
        body: { ids: [providerId] },
      })).status, role).toBe(403);
      expect((await request("/api/model-pool-members/remove", {
        cookie: cookieFor(role),
        method: "POST",
        body: { ids: [providerId], reason: "maintenance" },
      })).status, role).toBe(403);
      expect((await request("/api/model-pool-settings", { cookie: cookieFor(role), method: "PATCH", body: { paidDailyTokenLimit: 10 } })).status, role).toBe(403);
      expect((await request("/api/model-usage-events", { cookie: cookieFor(role) })).status, role).toBe(403);
    }

    const rotated = await request(`/api/model-providers/${providerId}`, {
      cookie: cookieFor("config"),
      method: "PATCH",
      body: { apiKey: "rotated-secret" },
    });
    expect(rotated.status).toBe(200);
    expect(JSON.stringify(rotated.body)).not.toContain("rotated-secret");
    expect((await request("/api/model-pool-members/verify", {
      cookie: cookieFor("config"),
      method: "POST",
      body: { ids: [] },
    })).status).toBe(400);

    const installed = await request("/api/model-pools/qianwen-free/install", { cookie: cookieFor("config"), method: "POST" });
    expect(installed.status).toBe(200);
    const [first, second] = installed.body.data.created as string[];

    const removed = await request("/api/model-pool-members/remove", {
      cookie: cookieFor("config"),
      method: "POST",
      body: { ids: [first, second], reason: "quota", note: "额度耗尽" },
    });
    expect(removed.status).toBe(200);
    expect((await request("/api/model-pool-members/restore", {
      cookie: cookieFor("config"),
      method: "POST",
      body: { ids: [first] },
    })).status).toBe(200);

    const settings = await request("/api/model-pool-settings", {
      cookie: cookieFor("config"),
      method: "PATCH",
      body: { paidDailyTokenLimit: 500 },
    });
    expect(settings.status).toBe(200);

    for (const action of ["pool.create_provider", "pool.update_provider", "pool.install_preset", "pool.remove", "pool.restore", "pool.update_settings"]) {
      expect(auditEvents({ action, since: poolMarker }).length, action).toBeGreaterThan(0);
    }
    const poolAudits = JSON.stringify(auditEvents({ action: "pool.update_provider", since: poolMarker }));
    expect(poolAudits).not.toContain("rotated-secret");
    expect(poolAudits).not.toContain("pool-provider-secret");
  });

  it("audits configuration changes with actor, target and correlation id", async () => {
    const marker = auditMarker();
    const created = await request("/api/sections", {
      cookie: cookieFor("config"),
      method: "POST",
      body: { id: "cfg-section", name: "配置测试板块", prompt: "" },
      headers: { "x-request-id": "req-config-1" },
    });
    expect(created.status).toBe(200);

    const events = auditEvents({ action: "config.upsert_section", targetId: "cfg-section", since: marker });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({
      actor_user_id: userId("config-user"),
      actor_display: "配置人员",
      target_type: "section",
      target_id: "cfg-section",
      outcome: "success",
      correlation_id: "req-config-1",
    });
    expect(JSON.parse(event.metadata_json)).toEqual({ name: "配置测试板块" });

    const denied = await request("/api/sections", {
      cookie: cookieFor("operator"),
      method: "POST",
      body: { id: "cfg-denied", name: "越权板块", prompt: "" },
    });
    expect(denied.status).toBe(403);
    const denials = auditEvents({ action: "config.manage", outcome: "failure", since: marker });
    expect(denials.length).toBeGreaterThan(0);
    expect(denials.at(-1)).toMatchObject({ actor_user_id: userId("operator-user") });
    expect(db.prepare("SELECT id FROM analysis_sections WHERE id = 'cfg-denied'").get()).toBeUndefined();
  });

  it("opens audit queries to administrators only and never returns credentials", async () => {
    const model = await request("/api/model-configs", {
      cookie: cookieFor("config"),
      method: "POST",
      body: { name: "audit-model", baseUrl: "https://audit.example/v1", apiKey: "audit-secret-key-123", model: "audit-model", purpose: "text" },
    });
    expect(model.status).toBe(200);
    const modelId = model.body.data.id;

    expect((await request("/api/admin/audit-events")).status).toBe(401);
    for (const role of ["config", "operator", "reviewer", "readonly"]) {
      expect((await request("/api/admin/audit-events", { cookie: cookieFor(role) })).status, role).toBe(403);
    }

    const page = await request("/api/admin/audit-events?action=config.create_model&limit=10", { cookie: cookieFor("admin") });
    expect(page.status).toBe(200);
    expect(page.body.data.items.length).toBeGreaterThanOrEqual(1);
    expect(page.body.data.items[0]).toMatchObject({
      actorUserId: userId("config-user"),
      actorDisplay: "配置人员",
      action: "config.create_model",
      targetType: "model_config",
      targetId: modelId,
      outcome: "success",
      metadata: { name: "audit-model", purpose: "text" },
    });
    expect(page.body.data.items[0].occurredAt).toEqual(expect.any(String));

    const serialized = JSON.stringify(page.body);
    for (const secret of ["audit-secret-key-123", "config-password-123", "password_hash", "cc_sid"]) {
      expect(serialized).not.toContain(secret);
    }

    const filtered = await request("/api/admin/audit-events?outcome=failure&limit=5", { cookie: cookieFor("admin") });
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.items.every((item: { outcome: string }) => item.outcome === "failure")).toBe(true);
  });

  it("keeps backup and restore behind the administrator capability and audits them", async () => {
    expect((await request("/api/admin/backups")).status).toBe(401);
    for (const role of ["config", "operator", "reviewer", "readonly"]) {
      expect((await request("/api/admin/backups", { cookie: cookieFor(role) })).status, role).toBe(403);
      expect((await request("/api/admin/backups", { cookie: cookieFor(role), method: "POST" })).status, role).toBe(403);
      expect((await request("/api/admin/backups/restore", {
        cookie: cookieFor(role),
        method: "POST",
        body: { name: "missing", targetDir: os.tmpdir() },
      })).status, role).toBe(403);
      expect((await request("/api/admin/backups/drill", {
        cookie: cookieFor(role),
        method: "POST",
        body: { name: "missing" },
      })).status, role).toBe(403);
    }

    const backupMarker = auditMarker();
    const created = await request("/api/admin/backups", { cookie: cookieFor("admin"), method: "POST" });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ name: expect.any(String), verified: true });
    expect(JSON.stringify(created.body)).not.toContain(os.tmpdir().replace(/\\/g, ""));

    const listed = await request("/api/admin/backups", { cookie: cookieFor("admin") });
    expect(listed.body.data.map((item: { name: string }) => item.name)).toContain(created.body.data.name);

    const target = path.join(os.tmpdir(), `configuration-admin-restore-${crypto.randomUUID()}`);
    restoreTargets.push(target);
    const restored = await request("/api/admin/backups/restore", {
      cookie: cookieFor("admin"),
      method: "POST",
      body: { name: created.body.data.name, targetDir: target },
    });
    expect(restored.status).toBe(200);
    expect(fs.existsSync(path.join(target, "data/app.db"))).toBe(true);

    const drilled = await request("/api/admin/backups/drill", {
      cookie: cookieFor("admin"),
      method: "POST",
      body: { name: created.body.data.name },
    });
    expect(drilled.status).toBe(200);
    expect(drilled.body.data).toMatchObject({
      backup: created.body.data.name,
      ok: true,
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "database", ok: true }),
        expect.objectContaining({ name: "model-credentials", ok: true }),
      ]),
    });
    expect(drilled.body.data).not.toHaveProperty("directory");

    expect(auditEvents({ action: "backup.create", outcome: "success", since: backupMarker })).toHaveLength(1);
    const restoreEvents = auditEvents({ action: "backup.restore", outcome: "success", since: backupMarker });
    expect(restoreEvents).toHaveLength(1);
    expect(restoreEvents[0]).toMatchObject({ actor_user_id: userId("admin"), target_id: created.body.data.name, outcome: "success" });
    expect(auditEvents({ action: "backup.drill", targetId: created.body.data.name, outcome: "success", since: backupMarker })).toHaveLength(1);

    const traversal = await request("/api/admin/backups/restore", {
      cookie: cookieFor("admin"),
      method: "POST",
      body: { name: "../secrets", targetDir: path.join(os.tmpdir(), `configuration-admin-restore-${crypto.randomUUID()}`) },
    });
    expect(traversal.status).toBe(400);
  });
});
