import { describe, expect, it } from "vitest";
import type { ModelConfig } from "../../shared/types";
import {
  isPoolMemberEligible,
  isPoolMemberVisible,
  rankDefaultFirstModelCandidates,
  rankEligibleModelCandidates,
} from "./model-pool-policy";

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
  billingMode: "paid",
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
  capabilityEligible: true,
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

  it("excludes free members even when their capability check passes", () => {
    expect(isPoolMemberEligible({ ...baseMember, billingMode: "free" }, {
      now: Date.parse("2026-09-25T08:00:00.000Z"),
      allowPaid: true,
      failedMemberIds: new Set(),
      capabilityEligible: true,
    })).toBe(false);
  });

  it("shows only enabled paid members with fresh capability verification", () => {
    expect(isPoolMemberVisible(baseMember)).toBe(true);
    expect(isPoolMemberVisible({ ...baseMember, billingMode: "free" })).toBe(false);
    expect(isPoolMemberVisible({ ...baseMember, capabilityEligible: false })).toBe(false);
    expect(isPoolMemberVisible({ ...baseMember, isEnabled: false })).toBe(false);
  });

  it("ranks only fresh paid members and does not expose free fallbacks", () => {
    const ranked = rankEligibleModelCandidates([
      { ...baseMember, id: "free", billingMode: "free" },
      { ...baseMember, id: "paid-default", isPurposeDefault: true, priority: 1 },
      { ...baseMember, id: "paid-fallback", priority: 2 },
    ], {
      now: Date.parse("2026-09-25T08:00:00.000Z"),
      allowPaid: true,
      failedMemberIds: new Set(),
    });

    expect(ranked.map((member) => member.id)).toEqual(["paid-fallback", "paid-default"]);
  });

  it("ranks the purpose default first and then preserves manual priority", () => {
    const ranked = rankDefaultFirstModelCandidates([
      { ...baseMember, id: "lower-priority", priority: 10 },
      { ...baseMember, id: "default", priority: 100, isPurposeDefault: true },
      { ...baseMember, id: "higher-priority", priority: 1 },
    ]);

    expect(ranked.map((member) => member.id)).toEqual([
      "default",
      "higher-priority",
      "lower-priority",
    ]);
  });
});
