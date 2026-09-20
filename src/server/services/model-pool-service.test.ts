import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelPurpose } from "../../shared/types";
import { withModelBudget } from "../ai/model-budget";
import { callVisionModel } from "../ai/openai-compatible-client";
import { db, initDb } from "../db/client";
import { createModelConfig } from "./model-config-service";
import {
  callModelPool,
  rankPoolCandidates,
} from "./model-pool-service";
import { createModelProvider, type ResolvedPoolMember } from "./model-provider-service";
import { updateModelPoolSettings } from "./model-pool-admin-service";

vi.mock("../ai/openai-compatible-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../ai/openai-compatible-client")>();
  return { ...original, callVisionModel: vi.fn() };
});

const NOW = Date.parse("2026-09-16T08:00:00.000Z");
const DEFAULT_USAGE = { prompt_tokens: 12, completion_tokens: 8 };

function member(
  id: string,
  patch: Partial<ResolvedPoolMember> = {},
): ResolvedPoolMember {
  return {
    id,
    name: id,
    baseUrl: "https://model.test/v1",
    maskedApiKey: "********",
    apiKey: "secret",
    model: id,
    supportsVision: false,
    temperature: 0,
    maxTokens: 100,
    isDefault: false,
    purpose: "text",
    isPurposeDefault: false,
    isEnabled: true,
    capabilityStatus: { text: true, json: true, vision: false },
    capabilityCheckedAt: new Date(NOW).toISOString(),
    providerEnabled: true,
    poolEnabled: true,
    billingMode: "free",
    qualityTier: "A",
    priority: 100,
    thinkingMode: false,
    memberType: "general",
    quotaTotalTokens: 1000,
    quotaUsedTokens: 100,
    quotaExpiresAt: "2026-10-01T00:00:00.000Z",
    quotaSafetyRatio: 0.95,
    consecutiveFailures: 0,
    capabilityEligible: true,
    quotaBlocked: false,
    ...patch,
  };
}

function resetPoolData() {
  db.exec(`
    DELETE FROM model_usage_events;
    DELETE FROM model_configs;
    DELETE FROM model_providers;
  `);
  updateModelPoolSettings({
    paidDailyTokenLimit: 0,
    paidMonthlyTokenLimit: 0,
    capabilityTtlMs: 86_400_000,
  });
  const settingsColumns = new Set(
    (db.prepare("PRAGMA table_info(model_pool_settings)").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  if (settingsColumns.has("paid_daily_reserved_tokens")) {
    db.prepare(`UPDATE model_pool_settings SET
      paid_daily_reserved_tokens=0, paid_monthly_reserved_tokens=0
      WHERE id='default'`).run();
  }
}

function createPoolMember(options: {
  model: string;
  purpose?: ModelPurpose;
  billingMode?: "free" | "paid";
  qualityTier?: "A" | "B" | "C";
  priority?: number;
  maxTokens?: number;
  providerId?: string;
  isPurposeDefault?: boolean;
}) {
  const purpose = options.purpose ?? "text";
  const provider = options.providerId
    ? { id: options.providerId }
    : createModelProvider({
      name: `${options.model}-provider`,
      baseUrl: `https://${options.model}.example/v1`,
      apiKey: `${options.model}-secret`,
    });
  const created = createModelConfig({
    name: options.model,
    providerId: provider.id,
    baseUrl: `https://${options.model}.example/v1`,
    model: options.model,
    purpose,
    supportsVision: purpose === "vision",
    maxTokens: options.maxTokens ?? 100,
  });
  const capabilities = {
    text: true,
    json: true,
    vision: purpose === "vision",
    errors: {},
  };
  db.prepare(`UPDATE model_configs SET
    pool_enabled=1, billing_mode=?, quality_tier=?, priority=?,
    quota_total_tokens=?, quota_used_tokens=0, quota_expires_at=?,
    quota_safety_ratio=0.95, capability_json=?, capability_checked_at=?,
    is_purpose_default=?
    WHERE id=?`).run(
    options.billingMode ?? "free",
    options.qualityTier ?? "A",
    options.priority ?? 100,
    options.billingMode === "paid" ? null : 1000,
    options.billingMode === "paid" ? null : "2026-10-01T00:00:00.000Z",
    JSON.stringify(capabilities),
    Date.now(),
    options.isPurposeDefault ? 1 : 0,
    created.id,
  );
  return created.id;
}

function success(content = '{"ok":true}', usage: Record<string, number> = DEFAULT_USAGE) {
  return { content, raw: JSON.stringify({ content }), usage };
}

function events() {
  return db.prepare(`SELECT model_config_id, event_type, accounted_tokens, error_code
    FROM model_usage_events ORDER BY created_at, rowid`).all() as Array<Record<string, unknown>>;
}

function paidReservations() {
  return db.prepare(`SELECT paid_daily_reserved_tokens daily, paid_monthly_reserved_tokens monthly
    FROM model_pool_settings WHERE id='default'`).get() as { daily: number; monthly: number };
}

describe("pool candidate ranking", () => {
  it("excludes expired, safety-blocked, cooling-down, stale, failed, and OCR members", () => {
    const ranked = rankPoolCandidates([
      member("eligible"),
      member("expired", { quotaExpiresAt: "2026-09-15T00:00:00.000Z" }),
      member("safety", { quotaUsedTokens: 950, quotaBlocked: true }),
      member("cooldown", { cooldownUntil: "2026-09-16T09:00:00.000Z" }),
      member("stale", { capabilityEligible: false }),
      member("failed"),
      member("ocr", { memberType: "ocr" }),
    ], { now: NOW, allowPaid: false, failedMemberIds: new Set(["failed"]) });

    expect(ranked.map((item) => item.id)).toEqual(["eligible"]);
  });

  it("uses manual priority before model characteristics", () => {
    const ranked = rankPoolCandidates([
      member("earlier-tier-c", {
        quotaExpiresAt: "2026-09-20T00:00:00.000Z",
        qualityTier: "C",
        priority: 999,
      }),
      member("later", { quotaExpiresAt: "2026-11-01T00:00:00.000Z", priority: 1 }),
      member("earlier-more", { quotaExpiresAt: "2026-10-01T00:00:00.000Z", quotaUsedTokens: 100 }),
      member("earlier-less", { quotaExpiresAt: "2026-10-01T00:00:00.000Z", quotaUsedTokens: 800 }),
      member("tier-b", { qualityTier: "B", quotaExpiresAt: "2026-12-01T00:00:00.000Z" }),
      member("tier-c", { qualityTier: "C", quotaExpiresAt: "2026-12-01T00:00:00.000Z" }),
      member("thinking", { thinkingMode: true, priority: 999 }),
    ], { now: NOW, allowPaid: false, failedMemberIds: new Set() });

    expect(ranked.map((item) => item.id)).toEqual([
      "later",
      "earlier-more",
      "earlier-less",
      "tier-b",
      "tier-c",
      "earlier-tier-c",
    ]);
  });

  it("uses quality tier after manual priority", () => {
    const ranked = rankPoolCandidates([
      member("tier-c", { qualityTier: "C", priority: 10 }),
      member("tier-a", { qualityTier: "A", priority: 10 }),
      member("tier-b", { qualityTier: "B", priority: 10 }),
    ], { now: NOW, allowPaid: false, failedMemberIds: new Set() });

    expect(ranked.map((item) => item.id)).toEqual(["tier-a", "tier-b", "tier-c"]);
  });

  it("keeps free thinking models as a fallback after free non-thinking models", () => {
    const ranked = rankPoolCandidates([
      member("thinking", { thinkingMode: true, priority: 10 }),
      member("non-thinking", { thinkingMode: false, priority: 10 }),
    ], { now: NOW, allowPaid: false, failedMemberIds: new Set() });

    expect(ranked.map((item) => item.id)).toEqual(["non-thinking"]);
  });

  it("proves the comparator orders paid non-thinking before thinking when both remain eligible", () => {
    const ranked = rankPoolCandidates([
      member("thinking-paid", {
        billingMode: "paid",
        quotaTotalTokens: undefined,
        quotaExpiresAt: undefined,
        thinkingMode: true,
        priority: 10,
      }),
      member("non-thinking-paid", {
        billingMode: "paid",
        quotaTotalTokens: undefined,
        quotaExpiresAt: undefined,
        thinkingMode: false,
        priority: 10,
      }),
    ], { now: NOW, allowPaid: true, failedMemberIds: new Set() });

    expect(ranked.map((item) => item.id)).toEqual([
      "non-thinking-paid",
      "thinking-paid",
    ]);
  });

  it("proves manual priority precedes health within the same tier and mode", () => {
    const ranked = rankPoolCandidates([
      member("healthy-lower-priority", { priority: 20, consecutiveFailures: 0 }),
      member("unhealthy-higher-priority", { priority: 10, consecutiveFailures: 4 }),
      member("healthy-higher-priority", { priority: 30, consecutiveFailures: 0 }),
    ], { now: NOW, allowPaid: false, failedMemberIds: new Set() });

    expect(ranked.map((item) => item.id)).toEqual([
      "unhealthy-higher-priority",
      "healthy-lower-priority",
      "healthy-higher-priority",
    ]);
  });

  it("puts paid members last and removes them when paid allowance is zero", () => {
    const paid = member("paid", {
      billingMode: "paid",
      quotaTotalTokens: undefined,
      quotaExpiresAt: undefined,
    });
    const free = member("free");
    expect(rankPoolCandidates(
      [paid, free],
      { now: NOW, allowPaid: false, failedMemberIds: new Set() },
    ).map((item) => item.id)).toEqual(["free"]);
    expect(rankPoolCandidates(
      [paid, free],
      { now: NOW, allowPaid: true, failedMemberIds: new Set() },
    ).map((item) => item.id)).toEqual(["free", "paid"]);
  });

  it("keeps purpose defaults as the fallback within each billing mode", () => {
    const ranked = rankPoolCandidates([
      member("default-paid", {
        billingMode: "paid",
        quotaTotalTokens: undefined,
        quotaExpiresAt: undefined,
        priority: 1,
        isPurposeDefault: true,
      }),
      member("regular-paid", {
        billingMode: "paid",
        quotaTotalTokens: undefined,
        quotaExpiresAt: undefined,
        priority: 99,
      }),
      member("default-free", { priority: 1, isPurposeDefault: true }),
      member("regular-free", { priority: 99 }),
    ], { now: NOW, allowPaid: true, failedMemberIds: new Set() });

    expect(ranked.map((item) => item.id)).toEqual([
      "regular-free",
      "default-free",
      "regular-paid",
      "default-paid",
    ]);
  });
});

describe("model pool routing", () => {
  beforeEach(() => {
    initDb();
    resetPoolData();
    vi.mocked(callVisionModel).mockReset();
  });

  it("returns after the first successful candidate and records free usage", async () => {
    const first = createPoolMember({ model: "first", priority: 1 });
    createPoolMember({ model: "second", priority: 2 });
    vi.mocked(callVisionModel).mockResolvedValue(success());

    const result = await callModelPool([], { purpose: "text", operation: "first-success" });

    expect(result.model.id).toBe(first);
    expect(callVisionModel).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT quota_used_tokens FROM model_configs WHERE id=?").get(first))
      .toEqual({ quota_used_tokens: 20 });
    expect(events()).toEqual([
      expect.objectContaining({ model_config_id: first, event_type: "success", accounted_tokens: 20 }),
    ]);
  });

  it("uses a regular free member before the default free fallback", async () => {
    const fallback = createPoolMember({
      model: "default-fallback",
      priority: 1,
      isPurposeDefault: true,
    });
    const regular = createPoolMember({ model: "regular-first", priority: 20 });
    vi.mocked(callVisionModel).mockResolvedValue(success());

    const result = await callModelPool([], { purpose: "text", operation: "default-fallback" });

    expect(result.model.id).toBe(regular);
    expect(result.model.id).not.toBe(fallback);
  });

  it("marks quota exhaustion and switches immediately", async () => {
    const first = createPoolMember({ model: "quota-first", priority: 1 });
    const second = createPoolMember({ model: "quota-second", priority: 2 });
    vi.mocked(callVisionModel)
      .mockRejectedValueOnce(new Error("insufficient_quota (429)"))
      .mockResolvedValueOnce(success());

    const result = await callModelPool([], { purpose: "text", operation: "quota-switch" });

    expect(result.model.id).toBe(second);
    expect(callVisionModel).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT quota_exhausted_at FROM model_configs WHERE id=?").get(first))
      .toEqual({ quota_exhausted_at: expect.any(String) });
    expect(events().map((event) => event.event_type)).toEqual([
      "failure",
      "quota_exhausted",
      "switch",
      "success",
    ]);
  });

  it("applies cooldown and switches on a rate limit without retrying", async () => {
    const first = createPoolMember({ model: "rate-first", priority: 1 });
    createPoolMember({ model: "rate-second", priority: 2 });
    vi.mocked(callVisionModel)
      .mockRejectedValueOnce(new Error("rate limited (429)"))
      .mockResolvedValueOnce(success());

    await callModelPool([], { purpose: "text", operation: "rate-switch" });

    expect(callVisionModel).toHaveBeenCalledTimes(2);
    const state = db.prepare(`SELECT consecutive_failures, cooldown_until
      FROM model_configs WHERE id=?`).get(first) as any;
    expect(state.consecutive_failures).toBe(1);
    expect(Date.parse(state.cooldown_until)).toBeGreaterThan(Date.now());
    expect(events().map((event) => event.event_type)).toEqual([
      "failure",
      "cooldown",
      "switch",
      "success",
    ]);
  });

  it.each([
    ["service", new Error("busy (503)")],
    ["timeout", new DOMException("Model request timed out", "TimeoutError")],
  ])("retries one %s failure on the same member before switching", async (_kind, error) => {
    createPoolMember({ model: "transient-first", priority: 1 });
    createPoolMember({ model: "transient-second", priority: 2 });
    vi.mocked(callVisionModel)
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(success());

    await callModelPool([], { purpose: "text", operation: "transient-switch" });

    expect(vi.mocked(callVisionModel).mock.calls.map((call) => (call[0] as any).model))
      .toEqual(["transient-first", "transient-first", "transient-second"]);
  });

  it("disables the provider on authentication failure and switches", async () => {
    const provider = createModelProvider({
      name: "shared-auth-provider",
      baseUrl: "https://shared-auth.example/v1",
      apiKey: "auth-secret",
    });
    createPoolMember({ model: "auth-first", priority: 1, providerId: provider.id });
    createPoolMember({ model: "auth-sibling", priority: 2, providerId: provider.id });
    createPoolMember({ model: "auth-second-provider", priority: 3 });
    vi.mocked(callVisionModel)
      .mockRejectedValueOnce(new Error("invalid api key (401)"))
      .mockResolvedValueOnce(success());

    await callModelPool([], { purpose: "text", operation: "auth-switch" });

    expect(db.prepare("SELECT is_enabled FROM model_providers WHERE id=?").get(provider.id))
      .toEqual({ is_enabled: 0 });
    expect(vi.mocked(callVisionModel).mock.calls.map((call) => (call[0] as any).model))
      .toEqual(["auth-first", "auth-second-provider"]);
  });

  it.each([
    new Error("bad request (400)"),
    new Error("model not found (404)"),
  ])("disables only the member on a permanent model error and switches", async (error) => {
    const first = createPoolMember({ model: "bad-member", priority: 1 });
    createPoolMember({ model: "good-member", priority: 2 });
    vi.mocked(callVisionModel).mockRejectedValueOnce(error).mockResolvedValueOnce(success());

    await callModelPool([], { purpose: "text", operation: "member-disable" });

    expect(db.prepare("SELECT is_enabled FROM model_configs WHERE id=?").get(first))
      .toEqual({ is_enabled: 0 });
    expect(callVisionModel).toHaveBeenCalledTimes(2);
  });

  it("accepts locally repaired output without another transport call", async () => {
    createPoolMember({ model: "repair", priority: 1 });
    vi.mocked(callVisionModel).mockResolvedValue(success("almost-json"));

    const result = await callModelPool([], {
      purpose: "text",
      operation: "local-repair",
      validate: (content) => content === '{"ok":true}'
        ? { valid: true }
        : { valid: false, repairedContent: '{"ok":true}' },
    });

    expect(result.content).toBe('{"ok":true}');
    expect(callVisionModel).toHaveBeenCalledTimes(1);
  });

  it("retries invalid output once on the same member before switching", async () => {
    createPoolMember({ model: "invalid-first", priority: 1 });
    createPoolMember({ model: "valid-second", priority: 2 });
    vi.mocked(callVisionModel)
      .mockResolvedValueOnce(success("bad-one"))
      .mockResolvedValueOnce(success("bad-two"))
      .mockResolvedValueOnce(success('{"ok":true}'));

    const result = await callModelPool([], {
      purpose: "text",
      operation: "invalid-retry",
      validate: (content) => ({ valid: content === '{"ok":true}' }),
    });

    expect(result.model.model).toBe("valid-second");
    expect(vi.mocked(callVisionModel).mock.calls.map((call) => (call[0] as any).model))
      .toEqual(["invalid-first", "invalid-first", "valid-second"]);
    expect(events()).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: "failure", error_code: "invalid_output" }),
      expect.objectContaining({ event_type: "switch", error_code: "invalid_output" }),
    ]));
  });

  it("releases every paid reservation after invalid output retries and switching", async () => {
    const { withPaidTokenBudget } = await import("../ai/model-budget");
    createPoolMember({
      model: "paid-invalid-first",
      billingMode: "paid",
      priority: 1,
      maxTokens: 100,
    });
    createPoolMember({
      model: "paid-valid-second",
      billingMode: "paid",
      priority: 2,
      maxTokens: 100,
    });
    updateModelPoolSettings({ paidDailyTokenLimit: 1000, paidMonthlyTokenLimit: 1000 });
    vi.mocked(callVisionModel)
      .mockResolvedValueOnce(success("bad-one"))
      .mockResolvedValueOnce(success("bad-two"))
      .mockResolvedValueOnce(success('{"ok":true}'));

    await withPaidTokenBudget(
      () => callModelPool([], {
        purpose: "text",
        operation: "paid-invalid-switch",
        validate: (content) => ({ valid: content === '{"ok":true}' }),
      }),
      { maxPaidTokens: 300 },
    );

    expect(paidReservations()).toEqual({ daily: 0, monthly: 0 });
  });

  it("stops cancellation without switching", async () => {
    createPoolMember({ model: "cancel-first", priority: 1 });
    createPoolMember({ model: "cancel-second", priority: 2 });
    const controller = new AbortController();
    vi.mocked(callVisionModel).mockImplementationOnce(async () => {
      controller.abort(new DOMException("任务已取消", "AbortError"));
      throw controller.signal.reason;
    });

    await expect(callModelPool([], {
      purpose: "text",
      operation: "cancel",
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "cancelled" });
    expect(callVisionModel).toHaveBeenCalledTimes(1);
    expect(events().some((event) => event.event_type === "switch")).toBe(false);
  });

  it("treats a transport success as cancelled before success accounting", async () => {
    const { paidTokensUsed, withPaidTokenBudget } = await import("../ai/model-budget");
    createPoolMember({
      model: "paid-late-cancel",
      billingMode: "paid",
      maxTokens: 100,
    });
    updateModelPoolSettings({ paidDailyTokenLimit: 1000, paidMonthlyTokenLimit: 1000 });
    const controller = new AbortController();
    vi.mocked(callVisionModel).mockImplementationOnce(async () => {
      controller.abort(new DOMException("任务已取消", "AbortError"));
      return success();
    });
    let used = -1;

    await expect(withPaidTokenBudget(async () => {
      try {
        await callModelPool([], {
          purpose: "text",
          operation: "late-cancel",
          signal: controller.signal,
        });
      } finally {
        used = paidTokensUsed();
      }
    }, { maxPaidTokens: 100 })).rejects.toMatchObject({ code: "cancelled" });

    expect(used).toBe(0);
    expect(paidReservations()).toEqual({ daily: 0, monthly: 0 });
    expect(events().some((event) => event.event_type === "success")).toBe(false);
    expect(events().some((event) => event.event_type === "usage_unknown")).toBe(false);
    expect(events()).toEqual([
      expect.objectContaining({ event_type: "failure", error_code: "cancelled" }),
    ]);
  });

  it("does not decrement free quota when usage is unknown", async () => {
    const id = createPoolMember({ model: "free-unknown" });
    vi.mocked(callVisionModel).mockResolvedValue(success("ok", {}));

    await callModelPool([], { purpose: "text", operation: "free-unknown" });

    expect(db.prepare("SELECT quota_used_tokens FROM model_configs WHERE id=?").get(id))
      .toEqual({ quota_used_tokens: 0 });
    expect(events()).toEqual([
      expect.objectContaining({ event_type: "success", accounted_tokens: 0 }),
      expect.objectContaining({ event_type: "usage_unknown", accounted_tokens: 0 }),
    ]);
  });

  it("treats free usage as unknown when only prompt tokens are valid", async () => {
    const id = createPoolMember({ model: "free-partial-usage" });
    vi.mocked(callVisionModel).mockResolvedValue(success("ok", { prompt_tokens: 12 }));

    await callModelPool([], { purpose: "text", operation: "free-partial-usage" });

    expect(db.prepare("SELECT quota_used_tokens FROM model_configs WHERE id=?").get(id))
      .toEqual({ quota_used_tokens: 0 });
    expect(events()).toEqual([
      expect.objectContaining({ event_type: "success", accounted_tokens: 0 }),
      expect.objectContaining({ event_type: "usage_unknown", accounted_tokens: 0 }),
    ]);
  });

  it("retains maxTokens for unknown paid usage and keeps it in the batch total", async () => {
    const { paidTokensUsed, withPaidTokenBudget } = await import("../ai/model-budget");
    const id = createPoolMember({ model: "paid-unknown", billingMode: "paid", maxTokens: 100 });
    updateModelPoolSettings({ paidDailyTokenLimit: 1000, paidMonthlyTokenLimit: 1000 });
    vi.mocked(callVisionModel).mockResolvedValue(success("ok", {}));
    let used = 0;

    await withPaidTokenBudget(async () => {
      await callModelPool([], { purpose: "text", operation: "paid-unknown" });
      used = paidTokensUsed();
    }, { maxPaidTokens: 100 });

    expect(used).toBe(100);
    expect(events()).toEqual([
      expect.objectContaining({ model_config_id: id, event_type: "success", accounted_tokens: 0 }),
      expect.objectContaining({ model_config_id: id, event_type: "usage_unknown", accounted_tokens: 100 }),
    ]);
  });

  it.each([
    ["missing completion", { prompt_tokens: 12 }],
    ["fractional completion", { prompt_tokens: 12, completion_tokens: 1.5 }],
    ["negative prompt", { prompt_tokens: -1, completion_tokens: 8 }],
  ])("accounts paid %s usage as unknown at the reserved amount", async (_case, usage) => {
    const { paidTokensUsed, withPaidTokenBudget } = await import("../ai/model-budget");
    const id = createPoolMember({
      model: "paid-invalid-usage",
      billingMode: "paid",
      maxTokens: 100,
    });
    updateModelPoolSettings({ paidDailyTokenLimit: 1000, paidMonthlyTokenLimit: 1000 });
    vi.mocked(callVisionModel).mockResolvedValue(success("ok", usage));
    let used = 0;

    await withPaidTokenBudget(async () => {
      await callModelPool([], { purpose: "text", operation: `paid-${_case}` });
      used = paidTokensUsed();
    }, { maxPaidTokens: 100 });

    expect(used).toBe(100);
    expect(paidReservations()).toEqual({ daily: 0, monthly: 0 });
    expect(events()).toEqual([
      expect.objectContaining({ model_config_id: id, event_type: "success", accounted_tokens: 0 }),
      expect.objectContaining({ model_config_id: id, event_type: "usage_unknown", accounted_tokens: 100 }),
    ]);
  });

  it("rejects actual paid usage that exceeds the batch paid-token budget", async () => {
    const { paidTokensUsed, withPaidTokenBudget } = await import("../ai/model-budget");
    createPoolMember({ model: "paid-overrun", billingMode: "paid", maxTokens: 100 });
    updateModelPoolSettings({ paidDailyTokenLimit: 1000, paidMonthlyTokenLimit: 1000 });
    vi.mocked(callVisionModel).mockResolvedValue(success("ok", {
      prompt_tokens: 80,
      completion_tokens: 80,
    }));

    await expect(withPaidTokenBudget(
      () => callModelPool([], { purpose: "text", operation: "paid-overrun" }),
      { maxPaidTokens: 100 },
    )).rejects.toMatchObject({ code: "budget" });
    expect(paidTokensUsed()).toBe(0);
  });

  it("serializes persistent paid reservations across concurrent routes", async () => {
    const id = createPoolMember({ model: "paid-concurrent", billingMode: "paid", maxTokens: 100 });
    updateModelPoolSettings({ paidDailyTokenLimit: 100, paidMonthlyTokenLimit: 100 });
    let releaseTransport!: () => void;
    const transportReleased = new Promise<void>((resolve) => { releaseTransport = resolve; });
    vi.mocked(callVisionModel).mockImplementation(async () => {
      await transportReleased;
      return success("ok", {});
    });

    const first = import("../ai/model-budget").then(({ withPaidTokenBudget }) =>
      withPaidTokenBudget(
        () => callModelPool([], { purpose: "text", operation: "concurrent-first" }),
        { maxPaidTokens: 100 },
      ));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = import("../ai/model-budget").then(({ withPaidTokenBudget }) =>
      withPaidTokenBudget(
        () => callModelPool([], { purpose: "text", operation: "concurrent-second" }),
        { maxPaidTokens: 100 },
      ));
    await expect(second).rejects.toMatchObject({ code: "budget" });
    expect(callVisionModel).toHaveBeenCalledTimes(1);
    releaseTransport();
    await expect(first).resolves.toMatchObject({ model: expect.objectContaining({ id }) });
  });

  it("rolls back failure state and failure event when the policy transaction fails", async () => {
    const first = createPoolMember({ model: "atomic-rate", priority: 1 });
    createPoolMember({ model: "atomic-fallback", priority: 2 });
    db.exec(`CREATE TRIGGER fail_cooldown_event BEFORE INSERT ON model_usage_events
      WHEN NEW.event_type='cooldown'
      BEGIN SELECT RAISE(ABORT, 'forced cooldown failure'); END`);
    vi.mocked(callVisionModel)
      .mockRejectedValueOnce(new Error("rate limited (429)"));

    await expect(callModelPool([], { purpose: "text", operation: "atomic-rate" }))
      .rejects.toThrow("forced cooldown failure");

    expect(db.prepare(`SELECT consecutive_failures, cooldown_until, last_failure_at
      FROM model_configs WHERE id=?`).get(first)).toEqual({
      consecutive_failures: 0,
      cooldown_until: null,
      last_failure_at: null,
    });
    expect(events()).toEqual([]);
    db.exec("DROP TRIGGER fail_cooldown_event");
  });

  it("blocks paid transport when no batch allowance exists", async () => {
    const id = createPoolMember({ model: "paid-blocked", billingMode: "paid" });
    updateModelPoolSettings({ paidDailyTokenLimit: 1000, paidMonthlyTokenLimit: 1000 });

    await expect(callModelPool([], {
      purpose: "text",
      operation: "paid-blocked",
    })).rejects.toMatchObject({ code: "budget" });

    expect(callVisionModel).not.toHaveBeenCalled();
    expect(events()).toEqual([
      expect.objectContaining({ model_config_id: id, event_type: "paid_blocked", error_code: "budget" }),
    ]);
  });

  it("blocks before transport when batch, daily, or monthly paid limits cannot reserve maxTokens", async () => {
    const { withPaidTokenBudget } = await import("../ai/model-budget");
    const id = createPoolMember({ model: "paid-limits", billingMode: "paid", maxTokens: 100 });
    updateModelPoolSettings({ paidDailyTokenLimit: 150, paidMonthlyTokenLimit: 150 });
    db.prepare(`INSERT INTO model_usage_events
      (id,model_config_id,purpose,event_type,accounted_tokens,operation,created_at)
      VALUES ('existing-paid',?,'text','success',60,'previous',?)`)
      .run(id, new Date().toISOString());

    await expect(withPaidTokenBudget(
      () => callModelPool([], { purpose: "text", operation: "persisted-limit" }),
      { maxPaidTokens: 1000 },
    )).rejects.toMatchObject({ code: "budget" });
    expect(callVisionModel).not.toHaveBeenCalled();

    db.prepare("DELETE FROM model_usage_events").run();
    await expect(withPaidTokenBudget(
      () => callModelPool([], { purpose: "text", operation: "batch-limit" }),
      { maxPaidTokens: 99 },
    )).rejects.toMatchObject({ code: "budget" });
    expect(callVisionModel).not.toHaveBeenCalled();
    expect(events()).toEqual([
      expect.objectContaining({ model_config_id: id, event_type: "paid_blocked", error_code: "budget" }),
    ]);
  });

  it("keeps the paid token budget separate from the request-count budget", async () => {
    const { withPaidTokenBudget } = await import("../ai/model-budget");
    createPoolMember({ model: "separate-budget", billingMode: "paid", maxTokens: 100 });
    updateModelPoolSettings({ paidDailyTokenLimit: 1000, paidMonthlyTokenLimit: 1000 });
    vi.mocked(callVisionModel).mockResolvedValue(success());

    await expect(withPaidTokenBudget(
      () => withModelBudget(
        () => callModelPool([], { purpose: "text", operation: "separate-budget" }),
        { requests: 1 },
      ),
      { maxPaidTokens: 100 },
    )).resolves.toMatchObject({ content: '{"ok":true}' });
  });
});
