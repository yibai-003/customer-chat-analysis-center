import { describe, expect, it } from "vitest";
import type { BailianCatalogModel, BailianPoolSnapshot } from "../../shared/model-pool-sync";
import { selectBailianPoolCandidates } from "./model-pool-sync-policy";

const now = Date.parse("2026-10-12T00:00:00+08:00");

const catalog = (
  model: string,
  modalities: BailianCatalogModel["modalities"] = { input: ["Text"], output: ["Text"] },
  overrides: Partial<BailianCatalogModel> = {},
): BailianCatalogModel => ({
  model,
  name: model.toUpperCase(),
  provider: "qwen",
  capabilities: ["TG", ...(modalities.input.includes("Image") ? ["VU"] : [])],
  modalities,
  features: ["structured-outputs"],
  ...overrides,
});

const snapshot = (models: BailianCatalogModel[]): BailianPoolSnapshot => ({
  providerId: "bailian",
  capturedAt: "2026-10-12T00:00:00+08:00",
  accountMatchConfirmed: true,
  models,
});

describe("selectBailianPoolCandidates", () => {
  it("selects only Qwen text and vision models with required structured output", () => {
    const result = selectBailianPoolCandidates(snapshot([
      catalog("qwen-text"),
      catalog("QWEN-VL", { input: ["Text", "Image"], output: ["Text"] }),
      catalog("qwen-no-json", undefined, { features: [] }),
      catalog("qwen-no-text-output", { input: ["Text"], output: [] }),
      catalog("deepseek-chat"),
      catalog("qwen-offline", undefined, { offline: true }),
    ]), now);

    expect(result.candidates.map(({ model, purpose }) => ({ model, purpose }))).toEqual([
      { model: "qwen-text", purpose: "text" },
      { model: "QWEN-VL", purpose: "vision" },
    ]);
    expect(result.candidates[0]).not.toHaveProperty("quotaTotalTokens");
    expect(result.candidates[0]).not.toHaveProperty("quotaUsedTokens");
    expect(result.candidates[0]).not.toHaveProperty("quotaExpiresAt");
    expect(result.excluded).toEqual(expect.arrayContaining([
      { model: "qwen-no-json", reason: "missing_structured_outputs" },
      { model: "qwen-no-text-output", reason: "missing_capabilities" },
      { model: "deepseek-chat", reason: "unsupported_type" },
      { model: "qwen-offline", reason: "offline" },
    ]));
  });

  it("excludes duplicate catalog IDs and models without required modalities", () => {
    const result = selectBailianPoolCandidates(snapshot([
      catalog("qwen-duplicate"), catalog("qwen-duplicate"),
      catalog("qwen-no-image", { input: ["Text"], output: ["Text"] }, { capabilities: ["TG"] }),
    ]), now);

    expect(result.candidates).toEqual([
      expect.objectContaining({ model: "qwen-no-image", purpose: "text" }),
    ]);
    expect(result.excluded).toContainEqual({ model: "qwen-duplicate", reason: "duplicate_catalog" });
  });

  it("allows a currently available model with a future offline date", () => {
    const result = selectBailianPoolCandidates(snapshot([
      catalog("qwen-future-offline", undefined, { upcomingOfflineAt: "2026-10-13" }),
    ]), now);

    expect(result.candidates).toHaveLength(1);
  });
});
