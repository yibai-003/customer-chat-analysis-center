import type { SectionConfigVersion } from "../../shared/types";

export interface ReceptionKnowledgeContext {
  serialized: string;
  complete: boolean;
  includedBaseIds: string[];
  omittedBaseIds: string[];
  omittedItemCount: number;
}

type KnowledgeBase = SectionConfigVersion["knowledgeSnapshot"][number];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eligibleBase(base: KnowledgeBase) {
  if (!isObject(base) || base.isEnabled === false) return undefined;
  const items = Array.isArray(base.items)
    ? base.items.flatMap((item) => {
      if (!isObject(item) || item.isEnabled === false || !isObject(item.values)) return [];
      return [{ itemId: String(item.id ?? ""), values: item.values }];
    })
    : [];
  if (!items.length) return undefined;
  return {
    baseId: String(base.id ?? ""),
    name: String(base.name ?? ""),
    items,
  };
}

export function buildReceptionKnowledgeContext(
  snapshot: SectionConfigVersion["knowledgeSnapshot"] | undefined,
  maxChars = 20_000,
): ReceptionKnowledgeContext {
  const budget = Number.isFinite(maxChars) ? Math.max(0, maxChars) : 20_000;
  const candidates = (Array.isArray(snapshot) ? snapshot : [])
    .map(eligibleBase)
    .filter((base): base is NonNullable<ReturnType<typeof eligibleBase>> => Boolean(base));
  const included: NonNullable<ReturnType<typeof eligibleBase>>[] = [];
  const includedBaseIds: string[] = [];
  const omittedBaseIds: string[] = [];
  let omittedItemCount = 0;

  for (const candidate of candidates) {
    const next = JSON.stringify([...included, candidate]);
    if (next.length <= budget) {
      included.push(candidate);
      includedBaseIds.push(candidate.baseId);
    } else {
      omittedBaseIds.push(candidate.baseId);
      omittedItemCount += candidate.items.length;
    }
  }

  return {
    serialized: JSON.stringify(included),
    complete: omittedBaseIds.length === 0,
    includedBaseIds,
    omittedBaseIds,
    omittedItemCount,
  };
}
