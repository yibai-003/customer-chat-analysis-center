import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, initDb } from "../db/client";
import { createModelConfig, testModelCapabilities } from "./model-config-service";
import { createModelProvider } from "./model-provider-service";
import {
  getModelPoolSettings,
  getPoolSummary,
  listModelUsageEvents,
  listPoolMembers,
  removePoolMembers,
  restorePoolMembers,
  updateModelPoolSettings,
  updatePoolMember,
  verifyPoolMembers,
} from "./model-pool-admin-service";

vi.mock("./model-config-service", async (importOriginal) => {
  const original = await importOriginal<typeof import("./model-config-service")>();
  return { ...original, testModelCapabilities: vi.fn() };
});

function resetPoolData() {
  db.exec(`
    DELETE FROM model_usage_events;
    DELETE FROM model_configs;
    DELETE FROM model_providers;
  `);
  db.prepare(`UPDATE model_pool_settings SET
    paid_daily_token_limit=0, paid_monthly_token_limit=0, capability_ttl_ms=86400000`)
    .run();
}

function createDashScopeProvider() {
  return createModelProvider({
    name: "千问百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "dashscope-test-secret",
  });
}

function createPoolMember(
  providerId: string,
  options: {
    purpose?: "vision" | "text";
    memberType?: "general" | "ocr";
    poolEnabled?: boolean;
    model?: string;
  } = {},
) {
  const provider = db.prepare("SELECT base_url FROM model_providers WHERE id=?").get(providerId) as { base_url: string };
  const purpose = options.purpose ?? "vision";
  const member = createModelConfig({
    name: `${purpose} test member`,
    providerId,
    baseUrl: provider.base_url,
    model: options.model ?? `${purpose}-${randomUUID()}`,
    purpose,
    supportsVision: purpose === "vision",
  });
  db.prepare(`UPDATE model_configs SET
    pool_enabled=?, member_type=?, billing_mode='free', quota_total_tokens=1000000,
    quota_safety_ratio=0.95 WHERE id=?`)
    .run(options.poolEnabled ? 1 : 0, options.memberType ?? "general", member.id);
  return listPoolMembers().find((item) => item.id === member.id)!;
}

describe("model pool administration", () => {
  beforeEach(() => {
    initDb();
    resetPoolData();
    vi.mocked(testModelCapabilities).mockReset();
  });

  it("preserves manual state while editing supported member fields", () => {
    const provider = createDashScopeProvider();
    const created = createPoolMember(provider.id);
    const updated = updatePoolMember(created.id, {
      isEnabled: false,
      poolEnabled: true,
      billingMode: "paid",
      qualityTier: "B",
      priority: 7,
      quotaTotalTokens: 2_000_000,
      quotaUsedTokens: 12,
      quotaExpiresAt: "2026-12-31T23:59:59+08:00",
      quotaSafetyRatio: 0.9,
      model: "must-not-change",
    });

    expect(updated).toMatchObject({
      id: created.id,
      isEnabled: false,
      poolEnabled: true,
      billingMode: "paid",
      qualityTier: "B",
      priority: 7,
      quotaTotalTokens: 2_000_000,
      quotaUsedTokens: 12,
      quotaExpiresAt: "2026-12-31T23:59:59+08:00",
      quotaSafetyRatio: 0.9,
    });
    expect(updated.model).not.toBe("must-not-change");
    expect(listPoolMembers(updated.purpose).some((member) => member.id === created.id)).toBe(true);
    expect(() => updatePoolMember("missing", {})).toThrow("模型池成员不存在");
  });

  it("verifies unique IDs with concurrency two and enables passed members only when requested", async () => {
    const provider = createDashScopeProvider();
    const ids = Array.from({ length: 5 }, () => createPoolMember(provider.id).id);
    let active = 0;
    let maxActive = 0;
    vi.mocked(testModelCapabilities).mockImplementation(async (id) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const member = listPoolMembers().find((item) => item.id === id)!;
      return {
        model: member.model,
        purpose: member.purpose,
        capabilities: { text: true, json: true, vision: member.purpose === "vision", errors: {} },
        checkedAt: "2026-09-16T00:00:00.000Z",
      };
    });

    const disabledResults = await verifyPoolMembers([...ids, ids[0]], { enablePassed: false });
    expect(disabledResults).toHaveLength(ids.length);
    expect(maxActive).toBe(2);
    expect(listPoolMembers().filter((member) => ids.includes(member.id)).every((member) => !member.poolEnabled))
      .toBe(true);

    await verifyPoolMembers(ids, { enablePassed: true });
    expect(listPoolMembers().filter((member) => ids.includes(member.id)).every((member) => member.poolEnabled))
      .toBe(true);
    await expect(verifyPoolMembers(Array.from({ length: 51 }, () => randomUUID())))
      .rejects.toThrow("最多验证 50 个模型池成员");
  });

  it("keeps verification failures out of routing without auto-removing the member", async () => {
    const provider = createDashScopeProvider();
    const created = createPoolMember(provider.id, { poolEnabled: true });
    vi.mocked(testModelCapabilities).mockResolvedValueOnce({
      model: created.model,
      purpose: "vision",
      capabilities: { text: true, json: true, vision: false, errors: { vision: "INVALID_OUTPUT" } },
      checkedAt: "2026-09-16T00:00:00.000Z",
    });

    await expect(verifyPoolMembers([created.id], { enablePassed: true })).resolves.toEqual([
      expect.objectContaining({ id: created.id, passed: false }),
    ]);
    const member = listPoolMembers().find((item) => item.id === created.id)!;
    expect(member.poolEnabled).toBe(true);
    expect(member.capabilityEligible).toBe(false);
  });

  it("reports per-member error categories when a verification request throws", async () => {
    const provider = createDashScopeProvider();
    const created = createPoolMember(provider.id);
    vi.mocked(testModelCapabilities).mockRejectedValueOnce(new Error("模型服务错误 (401)"));

    const [result] = await verifyPoolMembers([created.id], { enablePassed: true });
    expect(result).toMatchObject({ id: created.id, passed: false, errorCode: "auth" });
    expect(result.error).toBeTruthy();
  });

  it("keeps verified OCR members disabled for general vision routing", async () => {
    const provider = createDashScopeProvider();
    const ocrIds = [
      createPoolMember(provider.id, { purpose: "vision", memberType: "ocr" }).id,
      createPoolMember(provider.id, { purpose: "vision", memberType: "ocr" }).id,
    ];
    vi.mocked(testModelCapabilities).mockImplementation(async (id) => {
      const capabilities = { text: true, json: true, vision: true, errors: {} };
      db.prepare("UPDATE model_configs SET capability_json=?, capability_checked_at=? WHERE id=?")
        .run(JSON.stringify(capabilities), Date.now(), id);
      const member = listPoolMembers("vision").find((item) => item.id === id)!;
      return {
        model: member.model,
        purpose: member.purpose,
        capabilities,
        checkedAt: "2026-09-16T00:00:00.000Z",
      };
    });

    await expect(verifyPoolMembers(ocrIds, { enablePassed: true })).resolves.toEqual([
      expect.objectContaining({ passed: true }),
      expect.objectContaining({ passed: true }),
    ]);
    expect(db.prepare(`SELECT id, pool_enabled, capability_json FROM model_configs
      WHERE id IN (?, ?) ORDER BY model`).all(...ocrIds)).toEqual([
      expect.objectContaining({ pool_enabled: 0, capability_json: expect.stringContaining('"vision":true') }),
      expect.objectContaining({ pool_enabled: 0, capability_json: expect.stringContaining('"vision":true') }),
    ]);
  });

  it("removes members with reason metadata and requires fresh verification after restore", () => {
    const provider = createDashScopeProvider();
    const first = createPoolMember(provider.id, { poolEnabled: true }).id;
    const second = createPoolMember(provider.id, { poolEnabled: true }).id;
    db.prepare(`UPDATE model_configs SET capability_json=?, capability_checked_at=?
      WHERE id IN (?,?)`)
      .run(JSON.stringify({ text: true, json: true, vision: true }), Date.now(), first, second);

    expect(removePoolMembers([first, second], { reason: "unstable", note: "连续切换" }))
      .toEqual({ removed: [first, second] });
    const removed = listPoolMembers().find((member) => member.id === first)!;
    expect(removed).toMatchObject({
      poolEnabled: false,
      poolRemovedReason: "unstable",
      poolRemovedNote: "连续切换",
    });
    expect(removed.poolRemovedAt).toBeTruthy();
    expect(db.prepare("SELECT id FROM model_configs WHERE id=?").get(first)).toEqual({ id: first });

    db.prepare("UPDATE model_configs SET capability_json=NULL, capability_checked_at=NULL WHERE id=?").run(first);
    expect(restorePoolMembers([first])).toEqual({ restored: [first] });
    const restored = listPoolMembers().find((member) => member.id === first)!;
    expect(restored.poolEnabled).toBe(true);
    expect(restored.poolRemovedAt).toBeUndefined();
    expect(restored.poolRemovedReason).toBeUndefined();
    expect(restored.capabilityEligible).toBe(false);
  });

  it("enabling a previously removed general member after verification clears the removal metadata", async () => {
    const provider = createDashScopeProvider();
    const created = createPoolMember(provider.id, { poolEnabled: false });
    removePoolMembers([created.id], { reason: "maintenance" });
    vi.mocked(testModelCapabilities).mockResolvedValueOnce({
      model: created.model,
      purpose: created.purpose,
      capabilities: { text: true, json: true, vision: true, errors: {} },
      checkedAt: "2026-09-16T00:00:00.000Z",
    });

    await expect(verifyPoolMembers([created.id], { enablePassed: true })).resolves.toEqual([
      expect.objectContaining({ id: created.id, passed: true }),
    ]);
    const member = listPoolMembers().find((item) => item.id === created.id)!;
    expect(member.poolEnabled).toBe(true);
    expect(member.poolRemovedAt).toBeUndefined();
  });

  it("rejects duplicate, unknown, empty and oversized member selections", () => {
    const provider = createDashScopeProvider();
    const id = createPoolMember(provider.id).id;
    expect(() => removePoolMembers([id, id], { reason: "maintenance" })).toThrow("成员 ID 不能重复");
    expect(() => restorePoolMembers(["missing-member"])).toThrow("模型池成员不存在");
    expect(() => removePoolMembers([], { reason: "maintenance" })).toThrow();
    expect(() => restorePoolMembers(Array.from({ length: 51 }, () => randomUUID()))).toThrow();
  });

  it("reads summaries, validates settings, and filters newest usage events", () => {
    const provider = createDashScopeProvider();
    const member = createPoolMember(provider.id, { purpose: "vision" });
    createPoolMember(provider.id, { purpose: "text" });
    expect(getPoolSummary()).toMatchObject({
      total: 2,
      vision: expect.objectContaining({ total: 1 }),
      text: expect.objectContaining({ total: 1 }),
    });

    expect(updateModelPoolSettings({
      paidDailyTokenLimit: 1000,
      paidMonthlyTokenLimit: 2000,
      capabilityTtlMs: 60_000,
    })).toEqual({
      paidDailyTokenLimit: 1000,
      paidMonthlyTokenLimit: 2000,
      capabilityTtlMs: 60_000,
    });
    expect(getModelPoolSettings().paidDailyTokenLimit).toBe(1000);
    expect(() => updateModelPoolSettings({ paidDailyTokenLimit: -1 })).toThrow();

    const insert = db.prepare(`INSERT INTO model_usage_events
      (id,model_config_id,provider_id,purpose,event_type,accounted_tokens,created_at)
      VALUES (?,?,?,?,?,?,?)`);
    insert.run("older", member.id, provider.id, "vision", "failure", 0, "2026-09-16T01:00:00.000Z");
    insert.run("newer", member.id, provider.id, "vision", "success", 12, "2026-09-16T02:00:00.000Z");
    expect(listModelUsageEvents({ purpose: "vision", modelConfigId: member.id, limit: 1 }))
      .toEqual([expect.objectContaining({ id: "newer", eventType: "success", accountedTokens: 12 })]);
  });

  it("places paid purpose defaults after free members while preserving free priority", () => {
    const provider = createDashScopeProvider();
    const free = createPoolMember(provider.id, { purpose: "text", poolEnabled: true });
    const paid = createModelConfig({
      name: "paid fallback",
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      model: "paid-fallback",
      purpose: "text",
      supportsVision: false,
    });
    db.prepare("UPDATE model_configs SET is_purpose_default=1, priority=0 WHERE id=?").run(paid.id);
    expect(listPoolMembers("text").map((item) => item.id)).toEqual([free.id, paid.id]);
  });
});
