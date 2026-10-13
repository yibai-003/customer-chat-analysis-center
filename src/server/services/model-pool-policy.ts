import type { ModelConfig } from "../../shared/types";

type Candidate = ModelConfig & { providerEnabled?: boolean };

export interface ModelCandidateOptions {
  now: number;
  allowPaid: boolean;
  failedMemberIds: ReadonlySet<string>;
  capabilityEligible?: boolean;
}

export function isPoolMemberVisible(
  member: Candidate,
  capabilityEligible = member.capabilityEligible,
) {
  return member.billingMode === "paid"
    && member.isEnabled
    && member.poolEnabled
    && member.providerEnabled !== false
    && capabilityEligible
    && member.memberType === "general";
}

export function isPoolMemberEligible(
  member: Candidate,
  options: ModelCandidateOptions,
) {
  if (!isPoolMemberVisible(member, options.capabilityEligible)
    || options.failedMemberIds.has(member.id)
    || !options.allowPaid) {
    return false;
  }
  if (member.cooldownUntil && Date.parse(member.cooldownUntil) > options.now) return false;
  return true;
}

export function rankModelCandidates<T extends ModelConfig>(members: T[]): T[] {
  const tier = { A: 0, B: 1, C: 2 } as const;
  return members.toSorted((left, right) => {
    if (left.isPurposeDefault !== right.isPurposeDefault) {
      return left.isPurposeDefault ? 1 : -1;
    }
    if (left.priority !== right.priority) return left.priority - right.priority;
    if (left.thinkingMode !== right.thinkingMode) return left.thinkingMode ? 1 : -1;
    if (tier[left.qualityTier] !== tier[right.qualityTier]) {
      return tier[left.qualityTier] - tier[right.qualityTier];
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
  return rankModelCandidates(eligible);
}

export function rankDefaultFirstModelCandidates<T extends ModelConfig>(members: T[]): T[] {
  return members.toSorted((left, right) => {
    if (left.isPurposeDefault !== right.isPurposeDefault) {
      return left.isPurposeDefault ? -1 : 1;
    }
    const rankedPair = rankModelCandidates([left, right]);
    if (rankedPair[0].id === left.id && rankedPair[1].id === right.id) return -1;
    if (rankedPair[0].id === right.id && rankedPair[1].id === left.id) return 1;
    return 0;
  });
}
