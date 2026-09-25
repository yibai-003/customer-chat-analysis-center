import { describe, expect, it } from "vitest";
import type { ModelConfig } from "../../shared/types";
import { isPoolMemberEligible } from "./model-pool-policy";

const baseMember: ModelConfig & { providerEnabled: boolean } = {
  id: "member-1",
  name: "测试模型",
  baseUrl: "https://model.test/v1",
  maskedApiKey: "********",
  model: "test-model",
  supportsVision: false,
  temperature: 0,
  maxTokens: 100,
  isDefault: false,
  purpose: "text",
  isPurposeDefault: false,
  isEnabled: true,
  capabilityStatus: { text: true, json: true, vision: false },
  capabilityCheckedAt: "2026-09-25T00:00:00.000Z",
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
  quotaExhaustedAt: undefined,
  cooldownUntil: undefined,
  consecutiveFailures: 0,
  lastSuccessAt: undefined,
  lastFailureAt: undefined,
  capabilityEligible: false,
  quotaBlocked: false,
  poolRemovedAt: undefined,
  poolRemovedReason: undefined,
  poolRemovedNote: undefined,
  providerEnabled: true,
};

describe("model pool eligibility policy", () => {
  it("uses a caller-provided capability result when evaluating readiness", () => {
    expect(isPoolMemberEligible(baseMember, {
      now: Date.parse("2026-09-25T08:00:00.000Z"),
      allowPaid: true,
      failedMemberIds: new Set(),
      capabilityEligible: true,
    })).toBe(true);

    expect(isPoolMemberEligible(baseMember, {
      now: Date.parse("2026-09-25T08:00:00.000Z"),
      allowPaid: true,
      failedMemberIds: new Set(),
      capabilityEligible: false,
    })).toBe(false);
  });
});
