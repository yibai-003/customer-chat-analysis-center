import type { ModelConfig } from "../../shared/types";

type Candidate = ModelConfig & { providerEnabled?: boolean };

export interface ModelCandidateOptions {
  now: number;
  allowPaid: boolean;
  failedMemberIds: ReadonlySet<string>;
}

function expiryTime(member: ModelConfig) {
  if (!member.quotaExpiresAt) return Number.POSITIVE_INFINITY;
  const value = Date.parse(member.quotaExpiresAt);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function remainingQuota(member: ModelConfig) {
  return Math.max(
    0,
    (member.quotaTotalTokens ?? Number.MAX_SAFE_INTEGER) - member.quotaUsedTokens,
  );
}

export function isPoolMemberEligible(
  member: Candidate,
  options: ModelCandidateOptions,
) {
  if (!member.isEnabled
    || !member.poolEnabled
    || member.providerEnabled === false
    || !member.capabilityEligible
    || member.memberType !== "general"
    || options.failedMemberIds.has(member.id)
    || (member.billingMode === "paid" && !options.allowPaid)) {
    return false;
  }
  if (member.cooldownUntil && Date.parse(member.cooldownUntil) > options.now) return false;
  if (member.billingMode === "free") {
    if (expiryTime(member) <= options.now) return false;
    const safetyLimit = (member.quotaTotalTokens ?? 0) * member.quotaSafetyRatio;
    if (member.quotaBlocked || member.quotaUsedTokens >= safetyLimit) return false;
  }
  return true;
}

export function rankModelCandidates<T extends ModelConfig>(members: T[]): T[] {
  const tier = { A: 0, B: 1, C: 2 } as const;
  return [...members].sort((left, right) => {
    if (left.billingMode !== right.billingMode) return left.billingMode === "free" ? -1 : 1;
    if (left.isPurposeDefault !== right.isPurposeDefault) {
      return left.isPurposeDefault ? 1 : -1;
    }
    if (left.priority !== right.priority) return left.priority - right.priority;
    if (left.thinkingMode !== right.thinkingMode) return left.thinkingMode ? 1 : -1;
    if (tier[left.qualityTier] !== tier[right.qualityTier]) {
      return tier[left.qualityTier] - tier[right.qualityTier];
    }
    if (left.billingMode === "free") {
      const quotaDifference = remainingQuota(right) - remainingQuota(left);
      if (quotaDifference) return quotaDifference;
      const expiryDifference = expiryTime(left) - expiryTime(right);
      if (expiryDifference) return expiryDifference;
    }
    if (left.consecutiveFailures !== right.consecutiveFailures) {
      return left.consecutiveFailures - right.consecutiveFailures;
    }
    return left.id.localeCompare(right.id);
  });
}

export function rankEligibleModelCandidates<T extends Candidate>(
  members: T[],
  options: ModelCandidateOptions,
) {
  const eligible = members.filter((member) => isPoolMemberEligible(member, options));
  const hasNonThinkingFree = eligible.some((member) =>
    member.billingMode === "free" && !member.thinkingMode
  );
  return rankModelCandidates(eligible.filter((member) =>
    !(hasNonThinkingFree && member.billingMode === "free" && member.thinkingMode)
  ));
}
