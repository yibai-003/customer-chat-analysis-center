import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, initDb } from "../db/client";
import { createModelConfig, testModelCapabilities } from "./model-config-service";
import { createModelProvider } from "./model-provider-service";
import { QIANWEN_FREE_POOL_PRESET } from "./qianwen-free-pool-preset";
import {
  getModelPoolSettings,
  getPoolSummary,
  installQianwenFreePool,
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

describe("model pool administration", () => {
  beforeEach(() => {
    initDb();
    resetPoolData();
    vi.mocked(testModelCapabilities).mockReset();
  });

  it("requires an enabled DashScope provider", () => {
    expect(() => installQianwenFreePool()).toThrow("请先配置并启用千问服务商凭证");
    createModelProvider({
      name: "disabled",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "disabled-secret",
      isEnabled: false,
    });
    expect(() => installQianwenFreePool()).toThrow("请先配置并启用千问服务商凭证");
  });

  it("installs every preset member idempotently with safe defaults", () => {
    createDashScopeProvider();
    const first = installQianwenFreePool();
    const second = installQianwenFreePool();

    expect(first.created).toHaveLength(QIANWEN_FREE_POOL_PRESET.length);
    expect(first.needsVerification).toEqual(first.created);
    expect(second.created).toEqual([]);
    expect(second.updated).toHaveLength(QIANWEN_FREE_POOL_PRESET.length);
    expect(second.needsVerification).toEqual(second.updated);
    expect(db.prepare("SELECT COUNT(*) count FROM model_configs WHERE preset_key IS NOT NULL").get())
      .toEqual({ count: QIANWEN_FREE_POOL_PRESET.length });
    expect(db.prepare(`SELECT COUNT(*) count FROM model_configs
      WHERE billing_mode='free' AND pool_enabled=0 AND quota_total_tokens=1000000
        AND quota_safety_ratio=0.95 AND capability_json IS NULL AND capability_checked_at IS NULL`).get())
      .toEqual({ count: QIANWEN_FREE_POOL_PRESET.length });
    expect(db.prepare(`SELECT COUNT(*) count FROM model_configs
      WHERE member_type='ocr' AND pool_enabled=0`).get()).toEqual({ count: 2 });
  });

  it("preserves manual state and initializes snapshot usage only when adopting unused legacy rows", () => {
    const provider = createDashScopeProvider();
    const adopted = createModelConfig({
      name: "existing qwen plus",
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      model: "qwen-plus",
      purpose: "text",
      supportsVision: false,
    });
    db.prepare(`UPDATE model_configs SET pool_enabled=1, capability_json=?, capability_checked_at=?,
      cooldown_until='2026-09-17T00:00:00.000Z', consecutive_failures=3 WHERE id=?`)
      .run(JSON.stringify({ text: true, json: true, vision: false }), Date.now(), adopted.id);

    installQianwenFreePool();
    let row = db.prepare(`SELECT quota_used_tokens, pool_enabled, capability_json, capability_checked_at,
      cooldown_until, consecutive_failures FROM model_configs WHERE id=?`).get(adopted.id) as any;
    expect(row).toMatchObject({
      quota_used_tokens: 333_600,
      pool_enabled: 1,
      cooldown_until: "2026-09-17T00:00:00.000Z",
      consecutive_failures: 3,
    });
    expect(row.capability_json).toContain('"text":true');
    expect(row.capability_checked_at).toBeTruthy();

    db.prepare("UPDATE model_configs SET pool_enabled=0, is_enabled=0, quota_used_tokens=456789 WHERE id=?")
      .run(adopted.id);
    installQianwenFreePool();
    row = db.prepare(`SELECT pool_enabled, is_enabled, quota_used_tokens, capability_json,
      cooldown_until, consecutive_failures FROM model_configs WHERE id=?`).get(adopted.id) as any;
    expect(row).toMatchObject({
      pool_enabled: 0,
      is_enabled: 0,
      quota_used_tokens: 456_789,
      cooldown_until: "2026-09-17T00:00:00.000Z",
      consecutive_failures: 3,
    });
    expect(row.capability_json).toContain('"text":true');
  });

  it("lists and edits only the supported member fields", () => {
    createDashScopeProvider();
    const id = installQianwenFreePool().created[0];
    const updated = updatePoolMember(id, {
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
      id,
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
    expect(listPoolMembers(updated.purpose).some((member) => member.id === id)).toBe(true);
    expect(() => updatePoolMember("missing", {})).toThrow("模型池成员不存在");
  });

  it("verifies unique IDs with concurrency two and enables passed members only when requested", async () => {
    createDashScopeProvider();
    const ids = installQianwenFreePool().created
      .filter((id) => listPoolMembers().find((member) => member.id === id)?.memberType === "general")
      .slice(0, 5);
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
    createDashScopeProvider();
    const [id] = installQianwenFreePool().created;
    db.prepare("UPDATE model_configs SET pool_enabled=1 WHERE id=?").run(id);
    vi.mocked(testModelCapabilities).mockResolvedValueOnce({
      model: "qwen3-vl-plus",
      purpose: "vision",
      capabilities: { text: true, json: true, vision: false, errors: { vision: "INVALID_OUTPUT" } },
      checkedAt: "2026-09-16T00:00:00.000Z",
    });

    await expect(verifyPoolMembers([id], { enablePassed: true })).resolves.toEqual([
      expect.objectContaining({ id, passed: false }),
    ]);
    const member = listPoolMembers().find((item) => item.id === id)!;
    expect(member.poolEnabled).toBe(true);
    expect(member.capabilityEligible).toBe(false);
  });

  it("reports per-member error categories when a verification request throws", async () => {
    createDashScopeProvider();
    const [id] = installQianwenFreePool().created;
    vi.mocked(testModelCapabilities).mockRejectedValueOnce(new Error("模型服务错误 (401)"));

    const [result] = await verifyPoolMembers([id], { enablePassed: true });
    expect(result).toMatchObject({ id, passed: false, errorCode: "auth" });
    expect(result.error).toBeTruthy();
  });

  it("keeps verified OCR preset members disabled for general vision routing", async () => {
    createDashScopeProvider();
    installQianwenFreePool();
    const ocrIds = listPoolMembers("vision")
      .filter((member) => member.memberType === "ocr")
      .map((member) => member.id);
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
    createDashScopeProvider();
    const created = installQianwenFreePool().created;
    const [first, second] = created;
    db.prepare(`UPDATE model_configs SET pool_enabled=1, capability_json=?, capability_checked_at=?
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
    createDashScopeProvider();
    const [id] = installQianwenFreePool().created
      .filter((candidate) => listPoolMembers().find((member) => member.id === candidate)?.memberType === "general");
    removePoolMembers([id], { reason: "maintenance" });
    vi.mocked(testModelCapabilities).mockResolvedValueOnce({
      model: "qwen3-vl-plus",
      purpose: "vision",
      capabilities: { text: true, json: true, vision: true, errors: {} },
      checkedAt: "2026-09-16T00:00:00.000Z",
    });

    await expect(verifyPoolMembers([id], { enablePassed: true })).resolves.toEqual([
      expect.objectContaining({ id, passed: true }),
    ]);
    const member = listPoolMembers().find((item) => item.id === id)!;
    expect(member.poolEnabled).toBe(true);
    expect(member.poolRemovedAt).toBeUndefined();
  });

  it("rejects duplicate, unknown, empty and oversized member selections", () => {
    createDashScopeProvider();
    const [id] = installQianwenFreePool().created;
    expect(() => removePoolMembers([id, id], { reason: "maintenance" })).toThrow("成员 ID 不能重复");
    expect(() => restorePoolMembers(["missing-member"])).toThrow("模型池成员不存在");
    expect(() => removePoolMembers([], { reason: "maintenance" })).toThrow();
    expect(() => restorePoolMembers(Array.from({ length: 51 }, () => randomUUID()))).toThrow();
  });

  it("reads summaries, validates settings, and filters newest usage events", () => {
    const provider = createDashScopeProvider();
    const [id] = installQianwenFreePool().created;
    expect(getPoolSummary()).toMatchObject({
      total: QIANWEN_FREE_POOL_PRESET.length,
      vision: expect.objectContaining({ total: 22 }),
      text: expect.objectContaining({ total: 29 }),
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
    insert.run("older", id, provider.id, "vision", "failure", 0, "2026-09-16T01:00:00.000Z");
    insert.run("newer", id, provider.id, "vision", "success", 12, "2026-09-16T02:00:00.000Z");
    expect(listModelUsageEvents({ purpose: "vision", modelConfigId: id, limit: 1 }))
      .toEqual([expect.objectContaining({ id: "newer", eventType: "success", accountedTokens: 12 })]);
  });
});
