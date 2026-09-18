import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { config } from "../config";
import { db, initDb } from "../db/client";
import { bootstrapFirstAdmin, createUser } from "./identity-service";
import { CORRELATION_HEADER } from "./correlation";

let server: Server;
let baseUrl: string;

const ADMIN = { username: "admin", password: "test-password-123", displayName: "测试管理员" };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function resetIdentity() {
  db.exec("DELETE FROM user_sessions; DELETE FROM users;");
  bootstrapFirstAdmin(ADMIN);
  createUser({ username: "operator-user", password: "operator-password-123", displayName: "操作人员", role: "operator" });
}

async function request(
  pathname: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string } = {},
) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return {
    status: response.status,
    correlationId: response.headers.get(CORRELATION_HEADER),
    body: await response.json().catch(() => ({})),
  };
}

async function login(username: string, password: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ username, password }),
  });
  return {
    status: response.status,
    correlationId: response.headers.get(CORRELATION_HEADER),
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}

function lastAudit(action: string) {
  return db.prepare("SELECT action, outcome, correlation_id, actor_user_id FROM audit_events WHERE action = ? ORDER BY rowid DESC LIMIT 1")
    .get(action) as { action: string; outcome: string; correlation_id: string | null; actor_user_id: string | null } | undefined;
}

beforeAll(async () => {
  initDb();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => resetIdentity());

afterAll(async () => {
  resetIdentity();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

describe("request correlation ids", () => {
  it("generates an unpredictable id when the client does not supply one and reuses it in audits", async () => {
    const response = await request("/api/auth/login", {
      method: "POST",
      body: { username: ADMIN.username, password: "wrong-password" },
    });

    expect(response.status).toBe(401);
    expect(response.correlationId).toMatch(UUID_PATTERN);
    expect(lastAudit("auth.login_failed")?.correlation_id).toBe(response.correlationId);
  });

  it("keeps a valid client correlation id and attaches it to success audits", async () => {
    const session = await login(ADMIN.username, ADMIN.password, { [CORRELATION_HEADER]: "trace-abc_123.def" });

    expect(session.status).toBe(200);
    expect(session.correlationId).toBe("trace-abc_123.def");
    expect(lastAudit("auth.login")).toMatchObject({ outcome: "success", correlation_id: "trace-abc_123.def" });
  });

  it("replaces malformed, over-long or unsafe ids instead of echoing or storing them", async () => {
    const invalid = ["has space", "comma,joined", "semi;colon", "a".repeat(200), "caf\u00e9-id"];
    for (const value of invalid) {
      const response = await login(ADMIN.username, "wrong-password", { [CORRELATION_HEADER]: value });
      expect(response.status).toBe(401);
      expect(response.correlationId, value).toMatch(UUID_PATTERN);
      expect(response.correlationId, value).not.toBe(value);
      expect(lastAudit("auth.login_failed")?.correlation_id).toBe(response.correlationId);
    }
    const stored = db.prepare("SELECT DISTINCT correlation_id FROM audit_events WHERE correlation_id LIKE '%space%' OR correlation_id LIKE '%comma%' OR correlation_id LIKE '%colon%'").all();
    expect(stored).toEqual([]);
  });

  it("shares one correlation id between an authenticated request and its denial audit", async () => {
    const operator = await login("operator-user", "operator-password-123");
    expect(operator.status).toBe(200);

    const denied = await request("/api/admin/users", {
      cookie: operator.cookie,
      headers: { [CORRELATION_HEADER]: "deny-trace-1" },
    });

    expect(denied.status).toBe(403);
    expect(denied.correlationId).toBe("deny-trace-1");
    expect(lastAudit("user.list")).toMatchObject({ outcome: "failure", correlation_id: "deny-trace-1" });
  });

  it("attaches the correlation id to logout audits", async () => {
    const session = await login(ADMIN.username, ADMIN.password);
    const logout = await request("/api/auth/logout", {
      method: "POST",
      cookie: session.cookie,
      headers: { [CORRELATION_HEADER]: "logout-trace-1" },
    });

    expect(logout.status).toBe(200);
    expect(lastAudit("auth.logout")).toMatchObject({ correlation_id: "logout-trace-1" });
  });

  it("audits backup verification with the request id and keeps it administrator-only", async () => {
    const operator = await login("operator-user", "operator-password-123");
    const denied = await request("/api/admin/backups/verify", {
      method: "POST",
      cookie: operator.cookie,
      headers: { [CORRELATION_HEADER]: "verify-deny-1" },
      body: { targetDir: "C:\\somewhere-else" },
    });
    expect(denied.status).toBe(403);
    expect(lastAudit("backup.verify")).toMatchObject({ outcome: "failure", correlation_id: "verify-deny-1" });

    const admin = await login(ADMIN.username, ADMIN.password);
    const missing = await request("/api/admin/backups/verify", {
      method: "POST",
      cookie: admin.cookie,
      headers: { [CORRELATION_HEADER]: "verify-trace-1" },
      body: { targetDir: `C:\\acceptance-missing-${Date.now()}` },
    });
    expect(missing.status).toBe(200);
    expect(missing.body.data).toMatchObject({ ok: false });
    expect(missing.body.data.checks.length).toBeGreaterThan(0);
    expect(lastAudit("backup.verify")).toMatchObject({ outcome: "failure", correlation_id: "verify-trace-1" });

    const forbiddenTarget = await request("/api/admin/backups/verify", {
      method: "POST",
      cookie: admin.cookie,
      body: { targetDir: path.join(config.dataDir, "restore-copy") },
    });
    expect(forbiddenTarget.status).toBe(400);
  });
});