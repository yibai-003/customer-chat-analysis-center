import { describe, expect, it } from "vitest";
import type { AnalysisField, ModelConfig } from "../../shared/types";
import { useModelReadiness } from "./useModelReadiness";

function field(overrides: Partial<AnalysisField> = {}): AnalysisField {
  return {
    id: "field-1",
    sectionId: "section-1",
    key: "summary",
    label: "摘要",
    type: "string",
    prompt: "",
    required: false,
    imageEnabled: false,
    dependsOn: [],
    sortOrder: 1,
    isEnabled: true,
    exportEnabled: true,
    executionType: "ai",
    ...overrides,
  };
}

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: "model-1",
    name: "模型",
    baseUrl: "https://example.com/v1",
    maskedApiKey: "********",
    model: "model-1",
    supportsVision: false,
    temperature: 0.2,
    maxTokens: 1500,
    isDefault: false,
    purpose: "text",
    isPurposeDefault: false,
    isEnabled: true,
    poolEnabled: true,
    billingMode: "free",
    qualityTier: "A",
    priority: 1,
    thinkingMode: false,
    memberType: "general",
    quotaUsedTokens: 0,
    quotaSafetyRatio: 0.95,
    consecutiveFailures: 0,
    capabilityEligible: true,
    quotaBlocked: false,
    ...overrides,
  };
}

describe("useModelReadiness", () => {
  it("is ready when any verified eligible member exists without being purpose-default", () => {
    const result = useModelReadiness(
      [
        model({ purpose: "text", isPurposeDefault: false }),
        model({
          id: "vision",
          purpose: "vision",
          supportsVision: true,
          isPurposeDefault: false,
        }),
      ],
      [field(), field({ id: "image", key: "image", imageEnabled: true })],
    );

    expect(result).toEqual({ needsVision: true, needsText: true, ready: true });
  });

  it("rejects disabled, out-of-pool, unverified, quota-blocked, and cooling members", () => {
    const blockedPatches: Partial<ModelConfig>[] = [
      { isEnabled: false },
      { poolEnabled: false },
      { capabilityEligible: false },
      { quotaBlocked: true },
      { cooldownUntil: "2026-09-17T00:00:00.000Z" },
    ];

    for (const patch of blockedPatches) {
      expect(useModelReadiness([model(patch)], [field()]).ready).toBe(false);
    }
  });
});
