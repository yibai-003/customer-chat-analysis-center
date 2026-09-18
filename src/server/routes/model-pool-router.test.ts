import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { db, initDb } from "../db/client";
import { createModelConfig } from "../services/model-config-service";
import { createModelProvider } from "../services/model-provider-service";
import { QIANWEN_FREE_POOL_PRESET } from "../services/qianwen-free-pool-preset";
import { loginAdmin } from "../auth/test-admin";

let server: Server;
let baseUrl: string;
let cookie: string;

function resetModelPoolData() {
  db.exec(`
    DELETE FROM model_usage_events;
    DELETE FROM model_configs;
    DELETE FROM model_providers;
  `);
  db.prepare(`UPDATE model_pool_settings SET
    paid_daily_token_limit=0, paid_monthly_token_limit=0, capability_ttl_ms=86400000`)
    .run();
}

async function jsonRequest(
  pathname: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...init?.headers },
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  initDb();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  cookie = await loginAdmin(baseUrl);
});

beforeEach(resetModelPoolData);

afterAll(async () => {
  resetModelPoolData();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

describe("model pool administration API", () => {
  it("creates, updates, and lists providers without exposing API keys", async () => {
    const secret = "route-provider-secret";
    const created = await jsonRequest("/api/model-providers", {
      method: "POST",
      body: JSON.stringify({
        name: "Route provider",
        baseUrl: "https://provider-route.example/v1",
        apiKey: secret,
      }),
    });

    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      success: true,
      data: {
        name: "Route provider",
        maskedApiKey: expect.stringMatching(/^\*+$/),
      },
      error: null,
    });
    expect(created.body.data).not.toHaveProperty("apiKey");
    expect(JSON.stringify(created.body)).not.toContain(secret);

    const updated = await jsonRequest(`/api/model-providers/${created.body.data.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Updated route provider" }),
    });
    expect(updated.body.data).toMatchObject({
      name: "Updated route provider",
      maskedApiKey: expect.stringMatching(/^\*+$/),
    });
    expect(updated.body.data).not.toHaveProperty("apiKey");

    const listed = await jsonRequest("/api/model-providers");
    expect(listed.body.data).toEqual([
      expect.objectContaining({
        id: created.body.data.id,
        maskedApiKey: expect.stringMatching(/^\*+$/),
      }),
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    expect(listed.body.data[0]).not.toHaveProperty("apiKey");
  });

  it("returns preset install changes and reports a missing reusable provider as conflict", async () => {
    const conflict = await jsonRequest("/api/model-pools/qianwen-free/install", {
      method: "POST",
    });
    expect(conflict).toEqual({
      status: 409,
      body: {
        success: false,
        data: null,
        error: "请先配置并启用千问服务商凭证",
      },
    });

    createModelProvider({
      name: "千问百炼",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "route-dashscope-secret",
    });
    const installed = await jsonRequest("/api/model-pools/qianwen-free/install", {
      method: "POST",
    });

    expect(installed.status).toBe(200);
    expect(installed.body.data.created).toHaveLength(QIANWEN_FREE_POOL_PRESET.length);
    expect(installed.body.data.updated).toEqual([]);
    expect(installed.body.data.needsVerification).toEqual(installed.body.data.created);

    const pools = await jsonRequest("/api/model-pools");
    expect(pools.body).toMatchObject({
      success: true,
      data: {
        members: expect.any(Array),
        summary: { total: QIANWEN_FREE_POOL_PRESET.length },
      },
      error: null,
    });
  });

  it("rejects verification requests containing more than 50 IDs", async () => {
    const response = await jsonRequest("/api/model-pools/qianwen-free/verify", {
      method: "POST",
      body: JSON.stringify({
        ids: Array.from({ length: 51 }, () => randomUUID()),
        enablePassed: true,
      }),
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      data: null,
    });
  });

  it("validates bulk verification, removal and restore requests", async () => {
    const provider = await jsonRequest("/api/model-providers", {
      method: "POST",
      body: JSON.stringify({
        name: "竞价池服务商",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKey: "bulk-route-secret",
      }),
    });
    expect(provider.status).toBe(200);
    const installed = await jsonRequest("/api/model-pools/qianwen-free/install", { method: "POST" });
    const [first, second] = installed.body.data.created;

    const emptyVerify = await jsonRequest("/api/model-pool-members/verify", {
      method: "POST",
      body: JSON.stringify({ ids: [] }),
    });
    expect(emptyVerify.status).toBe(400);

    const emptyRemoval = await jsonRequest("/api/model-pool-members/remove", {
      method: "POST",
      body: JSON.stringify({ ids: [], reason: "maintenance" }),
    });
    expect(emptyRemoval.status).toBe(400);

    const duplicate = await jsonRequest("/api/model-pool-members/remove", {
      method: "POST",
      body: JSON.stringify({ ids: [first, first], reason: "maintenance" }),
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toContain("重复");

    const oversized = await jsonRequest("/api/model-pool-members/restore", {
      method: "POST",
      body: JSON.stringify({ ids: Array.from({ length: 51 }, () => randomUUID()) }),
    });
    expect(oversized.status).toBe(400);

    const unknown = await jsonRequest("/api/model-pool-members/remove", {
      method: "POST",
      body: JSON.stringify({ ids: ["missing-member"], reason: "maintenance" }),
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toContain("不存在");

    const invalidReason = await jsonRequest("/api/model-pool-members/remove", {
      method: "POST",
      body: JSON.stringify({ ids: [first], reason: "made-up" }),
    });
    expect(invalidReason.status).toBe(400);

    const removal = await jsonRequest("/api/model-pool-members/remove", {
      method: "POST",
      body: JSON.stringify({ ids: [first, second], reason: "quota", note: "额度耗尽" }),
    });
    expect(removal.status).toBe(200);
    expect(removal.body.data).toEqual({ removed: [first, second] });

    const removedList = await jsonRequest("/api/model-pools");
    const removed = removedList.body.data.members.find((member: any) => member.id === first);
    expect(removed).toMatchObject({
      poolEnabled: false,
      poolRemovedReason: "quota",
      poolRemovedNote: "额度耗尽",
    });
    expect(removed.poolRemovedAt).toBeTruthy();

    const restore = await jsonRequest("/api/model-pool-members/restore", {
      method: "POST",
      body: JSON.stringify({ ids: [first] }),
    });
    expect(restore.status).toBe(200);
    expect(restore.body.data).toEqual({ restored: [first] });

    const restoredList = await jsonRequest("/api/model-pools");
    const restored = restoredList.body.data.members.find((member: any) => member.id === first);
    expect(restored).toMatchObject({ poolEnabled: true });
    expect(restored.poolRemovedAt).toBeUndefined();
  });

  it("patches only supported model-pool member fields", async () => {
    const provider = createModelProvider({
      name: "Member route provider",
      baseUrl: "https://member-route.example/v1",
      apiKey: "member-route-secret",
    });
    const member = createModelConfig({
      name: "Member route model",
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      model: "member-route-model",
      purpose: "text",
    });
    const expiry = "2026-12-31T23:59:59+08:00";
    const accepted = await jsonRequest(`/api/model-pool-members/${member.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        isEnabled: false,
        poolEnabled: true,
        billingMode: "free",
        qualityTier: "B",
        priority: 7,
        quotaTotalTokens: 2000,
        quotaUsedTokens: 12,
        quotaExpiresAt: expiry,
        quotaSafetyRatio: 0.9,
      }),
    });

    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({
      isEnabled: false,
      poolEnabled: true,
      billingMode: "free",
      qualityTier: "B",
      priority: 7,
      quotaTotalTokens: 2000,
      quotaUsedTokens: 12,
      quotaExpiresAt: expiry,
      quotaSafetyRatio: 0.9,
    });

    const rejected = await jsonRequest(`/api/model-pool-members/${member.id}`, {
      method: "PATCH",
      body: JSON.stringify({ model: "must-not-be-accepted" }),
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatchObject({ success: false, data: null });
  });

  it("rejects negative and unsafe budget settings", async () => {
    for (const patch of [
      { paidDailyTokenLimit: -1 },
      { paidMonthlyTokenLimit: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const response = await jsonRequest("/api/model-pool-settings", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, data: null });
    }

    const accepted = await jsonRequest("/api/model-pool-settings", {
      method: "PATCH",
      body: JSON.stringify({
        paidDailyTokenLimit: 1000,
        paidMonthlyTokenLimit: 2000,
        capabilityTtlMs: 60_000,
      }),
    });
    expect(accepted.body.data).toEqual({
      paidDailyTokenLimit: 1000,
      paidMonthlyTokenLimit: 2000,
      capabilityTtlMs: 60_000,
    });
    expect((await jsonRequest("/api/model-pool-settings")).body.data)
      .toEqual(accepted.body.data);
  });

  it("accepts usage-event filters and enforces the limit boundary", async () => {
    const provider = createModelProvider({
      name: "Event route provider",
      baseUrl: "https://event-route.example/v1",
      apiKey: "event-route-secret",
    });
    const member = createModelConfig({
      name: "Event route model",
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      model: "event-route-model",
      purpose: "vision",
    });
    const insert = db.prepare(`INSERT INTO model_usage_events
      (id,model_config_id,provider_id,purpose,event_type,accounted_tokens,created_at)
      VALUES (?,?,?,?,?,?,?)`);
    insert.run("older-route-event", member.id, provider.id, "vision", "failure", 0, "2026-09-16T01:00:00.000Z");
    insert.run("newer-route-event", member.id, provider.id, "vision", "success", 12, "2026-09-16T02:00:00.000Z");

    const filtered = await jsonRequest(
      `/api/model-usage-events?purpose=vision&eventType=failure&modelConfigId=${member.id}`
      + "&limit=200&cursor=2026-09-16T02%3A00%3A00.000Z",
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.data).toEqual([
      expect.objectContaining({
        id: "older-route-event",
        purpose: "vision",
        eventType: "failure",
        modelConfigId: member.id,
      }),
    ]);

    const tooLarge = await jsonRequest("/api/model-usage-events?limit=201");
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body).toMatchObject({ success: false, data: null });
  });

  it("maps missing providers and members to 404", async () => {
    const providerPatch = await jsonRequest("/api/model-providers/missing", {
      method: "PATCH",
      body: JSON.stringify({ name: "missing" }),
    });
    expect(providerPatch.status).toBe(404);

    const providerTest = await jsonRequest("/api/model-providers/missing/test", {
      method: "POST",
    });
    expect(providerTest.status).toBe(404);

    const memberPatch = await jsonRequest("/api/model-pool-members/missing", {
      method: "PATCH",
      body: JSON.stringify({ poolEnabled: true }),
    });
    expect(memberPatch.status).toBe(404);
  });

  it("keeps the legacy model-config routes mounted", async () => {
    const response = await jsonRequest("/api/model-configs");
    expect(response).toEqual({
      status: 200,
      body: { success: true, data: [], error: null },
    });
  });
});
