import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { db, initDb } from "../db/client";
import { ensureInitialAdminBootstrap } from "./bootstrap";
import {
  AUTH_ERRORS,
  bootstrapFirstAdmin,
  createUser,
  resetPassword,
  setUserEnabled,
} from "./identity-service";

let server: Server;
let baseUrl: string;

const ADMIN = { username: "admin", password: "test-password-123", displayName: "测试管理员" };

function resetIdentity() {
  db.exec("DELETE FROM user_sessions; DELETE FROM users;");
  bootstrapFirstAdmin(ADMIN);
}

async function request(pathname: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function login(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: ADMIN.username, password: ADMIN.password }),
  });
  if (!response.ok) throw new Error(`登录失败：${response.status}`);
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("登录未返回会话 Cookie");
  return header.split(";")[0]!;
}

async function anon(pathname: string, method = "GET") {
  return request(pathname, { method });
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

describe("authentication routes", () => {
  it("keeps /api/health public and rejects every other anonymous business call", async () => {
    const health = await anon("/api/health");
    expect(health.status).toBe(200);

    const denied = [
      ["/api/jobs", "GET"],
      ["/api/sections", "GET"],
      ["/api/records/missing/image", "GET"],
      ["/api/jobs/missing/export", "GET"],
      ["/api/ready", "GET"],
      ["/api/jobs/missing/records", "GET"],
    ] as const;
    for (const [pathname, method] of denied) {
      const result = await anon(pathname, method);
      expect(result.status, pathname).toBe(401);
      expect(result.body).toMatchObject({ success: false, data: null, error: AUTH_ERRORS.LOGIN_REQUIRED });
    }
  });

  it("reports hasAdmin public state and resolves the current user through /me", async () => {
    const status = await anon("/api/auth/status");
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ success: true, data: { hasAdmin: true }, error: null });

    const before = await anon("/api/auth/me");
    expect(before.body.data).toEqual({ user: null, capabilities: [] });

    const cookie = await login();
    const me = await request("/api/auth/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(me.body.data.capabilities).toEqual(expect.arrayContaining(["task:view", "task:import", "task:analyze", "task:export", "review:save", "config:manage", "admin:manage"]));
    expect(me.body.data.user).toMatchObject({
      username: ADMIN.username,
      role: "admin",
      isEnabled: true,
    });
    expect(JSON.stringify(me.body)).not.toContain("password_hash");
  });

  it("issues an HttpOnly, SameSite=Lax, Secure session cookie without leaking secrets", async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: ADMIN.username, password: ADMIN.password }),
    });
    const header = response.headers.get("set-cookie");
    expect(header).toBeTruthy();
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Secure");
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=");
    expect(response.status).toBe(200);

    const bodyText = await response.text();
    const token = header!.split(";")[0]!.split("=")[1]!;
    expect(bodyText).not.toContain(ADMIN.password);
    expect(bodyText).not.toContain(token);
    expect(bodyText).not.toContain("password_hash");

    const bad = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: ADMIN.username, password: "not-the-password" }),
    });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toMatch(/用户名或密码错误/);
  });

  it("rejects login before any account exists with a host-local bootstrap hint", async () => {
    db.exec("DELETE FROM user_sessions; DELETE FROM users;");
    vi.stubEnv("FIRST_ADMIN_USERNAME", "");
    vi.stubEnv("FIRST_ADMIN_PASSWORD", "");
    vi.stubEnv("FIRST_ADMIN_DISPLAY_NAME", "");
    try {
      const result = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: "someone", password: ADMIN.password }),
      });
      expect(result.status).toBe(409);
      expect(result.body.error).toContain("bootstrap:admin");
      expect((await anon("/api/auth/status")).body.data).toEqual({ hasAdmin: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("revokes the session on logout and rejects the old cookie afterwards", async () => {
    const cookie = await login();
    expect((await request("/api/jobs", { headers: { cookie } })).status).toBe(200);

    const logout = await request("/api/auth/logout", { method: "POST", headers: { cookie } });
    expect(logout.status).toBe(200);
    expect(logout.body.data).toBe(true);

    const after = await request("/api/jobs", { headers: { cookie } });
    expect(after.status).toBe(401);

    const cookie2 = await login();
    expect((await request("/api/jobs", { headers: { cookie: cookie2 } })).status).toBe(200);
  });

  it("rejects expired sessions server-side even when the cookie is still valid", async () => {
    const cookie = await login();
    db.exec("UPDATE user_sessions SET expires_at = datetime('now','-1 hour')");
    const result = await request("/api/jobs", { headers: { cookie } });
    expect(result.status).toBe(401);
  });

  it("revokes all sessions immediately when the account is disabled", async () => {
    const cookie = await login();
    createUser({ username: "standby-admin", password: "standby-admin-password-1", displayName: "备用管理员", role: "admin" });
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(ADMIN.username) as { id: string };
    setUserEnabled(user.id, false);

    const denied = await request("/api/jobs", { headers: { cookie } });
    expect(denied.status).toBe(401);

    const blocked = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: ADMIN.username, password: ADMIN.password }),
    });
    expect(blocked.status).toBe(401);
    expect(blocked.body.error).toContain("停用");

    setUserEnabled(user.id, true);
    const fresh = await login();
    expect((await request("/api/jobs", { headers: { cookie: fresh } })).status).toBe(200);
  });

  it("revokes active sessions when an administrator resets the password", async () => {
    const cookie = await login();
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(ADMIN.username) as { id: string };
    resetPassword(user.id, "brand-new-password-1",);

    const denied = await request("/api/jobs", { headers: { cookie } });
    expect(denied.status).toBe(401);

    const oldPassword = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: ADMIN.username, password: ADMIN.password }),
    });
    expect(oldPassword.status).toBe(401);
  });

  it("does not expose any reusable bootstrap endpoint after the first administrator", async () => {
    const attempted = await request("/api/auth/bootstrap", { method: "POST", body: JSON.stringify({}) });
    expect(attempted.status).toBe(401);
    expect(attempted.body.success).toBe(false);
    expect(ensureInitialAdminBootstrap()).toBe(false);
    expect(db.prepare("SELECT COUNT(*) n FROM users").get().n).toBe(1);
  });

  it("route-level error responses never serialize credentials", async () => {
    const cookie = await login();
    const connection = await request(`/api/model-configs/missing/test`, { method: "POST", headers: { cookie } });
    expect([400, 404, 500]).toContain(connection.status);
    expect(JSON.stringify(connection.body)).not.toContain(ADMIN.password);
    expect(JSON.stringify(connection.body)).not.toContain("password_hash");
  });
});