import { describe, expect, it } from "vitest";
import type {
  BailianCatalogModel,
  BailianPoolSnapshot,
  BailianQuotaRecord,
} from "../../shared/model-pool-sync";
import { selectBailianPoolCandidates } from "./model-pool-sync-policy";

const now = Date.parse("2026-10-10T00:00:00+08:00");

const catalog = (
  model: string,
  type: "text" | "vision" | "omni",
  overrides: Partial<BailianCatalogModel> = {},
): BailianCatalogModel => ({
  model,
  name: model.toUpperCase(),
  provider: type === "text" ? "deepseek" : "qwen",
  capabilities: [type === "text" ? "TG" : type === "omni" ? "Multimodal-Omni" : "VU"],
  modalities: {
    input: type === "text" ? ["Text"] : ["Image", "Text"],
    output: ["Text"],
  },
  features: ["structured-outputs"],
  ...overrides,
});

const quota = (
  model: string,
  type: string,
  overrides: Partial<BailianQuotaRecord> = {},
): BailianQuotaRecord => ({
  model,
  type,
  remaining: 900_000,
  total: 1_000_000,
  expires: "2026-10-31",
  autoStop: true,
  ...overrides,
});

const snapshot = (
  quotas: BailianQuotaRecord[],
  models: BailianCatalogModel[],
): BailianPoolSnapshot => ({
  providerId: "bailian",
  capturedAt: "2026-10-10T00:00:00+08:00",
  accountMatchConfirmed: true,
  quotas,
  models,
});

describe("selectBailianPoolCandidates", () => {
  it("selects exact text, vision, and multimodal versions with a shared quota policy", () => {
    const result = selectBailianPoolCandidates(
      snapshot(
        [
          quota("chat-text", "Text"),
          quota("chat-vision-snapshot", "Vision"),
          quota("chat-omni", "Multimodal"),
          quota("deepseek-chat", "Text"),
          quota("kimi-chat", "Text"),
          quota("chat-vision", "Vision"),
        ],
        [
          catalog("chat-text", "text"),
          catalog("chat-vision-snapshot", "vision"),
          catalog("chat-omni", "omni"),
          catalog("deepseek-chat", "text", { provider: "deepseek" }),
          catalog("kimi-chat", "text", { provider: "moonshot-ai" }),
          catalog("chat-vision", "vision", { offline: true }),
          catalog("chat-text-2026-10-01", "vision"),
        ],
      ),
      now,
    );

    expect(result.candidates).toEqual([
      expect.objectContaining({ model: "chat-text", purpose: "text", quotaUsedTokens: 100_000 }),
      expect.objectContaining({ model: "chat-vision-snapshot", purpose: "vision" }),
      expect.objectContaining({ model: "chat-omni", purpose: "vision" }),
      expect.objectContaining({ model: "deepseek-chat", purpose: "text" }),
      expect.objectContaining({ model: "kimi-chat", purpose: "text" }),
    ]);
    expect(result.candidates.some((item) => item.model === "chat-vision")).toBe(false);
    expect(result.candidates.some((item) => item.model === "chat-text-2026-10-01")).toBe(false);
    expect(result.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: "chat-vision", reason: "offline" }),
    ]));
    expect(result.candidates.every((item) => item.qualityTier === "A"
      && item.thinkingMode === false && item.memberType === "general")).toBe(true);
  });

  it("reports unsafe, unsupported, malformed, and unmatched quota records", () => {
    const result = selectBailianPoolCandidates(
      snapshot(
        [
          quota("audio", "Audio"),
          quota("embedding", "Embedding"),
          quota("unknown", "Mystery"),
          quota("missing", "Text"),
          quota("duplicate", "Text"),
          quota("offline", "Text"),
          quota("no-json", "Text"),
          quota("no-auto-stop", "Text", { autoStop: false }),
          quota("zero", "Text", { remaining: 0 }),
          quota("negative", "Text", { remaining: -1 }),
          quota("fraction", "Text", { remaining: 1.5 }),
          quota("expired", "Text", { expires: "2026-10-09" }),
          quota("bad-date", "Text", { expires: "not-a-date" }),
          quota("low-safety", "Text", { remaining: 50_000 }),
        ],
        [
          catalog("duplicate", "text"), catalog("duplicate", "text"),
          catalog("offline", "text", { offline: true }),
          catalog("no-json", "text", { features: [] }),
          catalog("no-auto-stop", "text"), catalog("zero", "text"),
          catalog("negative", "text"), catalog("fraction", "text"),
          catalog("expired", "text"), catalog("bad-date", "text"),
          catalog("low-safety", "text"),
        ],
      ),
      now,
    );

    expect(result.candidates).toEqual([]);
    expect(result.excluded).toEqual(expect.arrayContaining([
      { model: "audio", reason: "unsupported_type" },
      { model: "embedding", reason: "unsupported_type" },
      { model: "unknown", reason: "unsupported_type" },
      { model: "missing", reason: "missing_catalog" },
      { model: "duplicate", reason: "duplicate_catalog" },
      { model: "offline", reason: "offline" },
      { model: "no-json", reason: "missing_structured_outputs" },
      { model: "no-auto-stop", reason: "auto_stop_disabled" },
      { model: "zero", reason: "invalid_quota" },
      { model: "negative", reason: "invalid_quota" },
      { model: "fraction", reason: "invalid_quota" },
      { model: "expired", reason: "expired" },
      { model: "bad-date", reason: "invalid_expiry" },
      { model: "low-safety", reason: "low_safety_margin" },
    ]));
  });

  it("rejects duplicate quota rows and impossible or permissive expiry values", () => {
    const result = selectBailianPoolCandidates(
      snapshot(
        [
          quota("duplicate-quota", "Text"),
          quota("duplicate-quota", "Text", { remaining: 800_000 }),
          quota("impossible-date", "Text", { expires: "2026-02-30" }),
          quota("permissive-time", "Text", { expires: "2026-10-10T00:00:00" }),
          quota("invalid-time", "Text", { expires: "2026-10-10T25:00:00+08:00" }),
        ],
        [
          catalog("duplicate-quota", "text"),
          catalog("impossible-date", "text"),
          catalog("permissive-time", "text"),
          catalog("invalid-time", "text"),
        ],
      ),
      now,
    );

    expect(result.candidates).toEqual([]);
    expect(result.excluded).toEqual(expect.arrayContaining([
      { model: "duplicate-quota", reason: "duplicate_quota" },
      { model: "impossible-date", reason: "invalid_expiry" },
      { model: "permissive-time", reason: "invalid_expiry" },
      { model: "invalid-time", reason: "invalid_expiry" },
    ]));
  });
});
