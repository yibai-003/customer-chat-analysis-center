import { assertRecordOwnership } from "../run-ownership";
import { checkModelBudget, withModelBudget } from "../../ai/model-budget";
import { assertAnalysisActive } from "../analysis-cancellation";
import crypto from "node:crypto";
import { db } from "../../db/client";
import type {
  AnalysisField,
  KnowledgeCandidate,
  KnowledgeColumn,
  KnowledgeMatchResult,
  ModelRouteResult,
  SectionConfigVersion,
} from "../../../shared/types";
import { buildKnowledgeMatchMessages } from "../../ai/knowledge-match-prompt-builder";
import { callModelPool } from "../model-pool-service";
import { getKnowledgeBase } from "./knowledge-repository";
import { searchKnowledge } from "./knowledge-search-service";

const MATCH_CACHE_TTL_MS = 15 * 60 * 1000;
const matchCache = new Map<string, { itemId: string; expiresAt: number }>();

function parseKnowledgeItemId(raw: string): string | undefined {
  const text = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const knowledgeItemId = (parsed as Record<string, unknown>).knowledgeItemId;
    return typeof knowledgeItemId === "string" ? knowledgeItemId : undefined;
  } catch {
    return undefined;
  }
}

function buildSearchQuery(dependencies: Record<string, unknown>): string {
  return JSON.stringify(dependencies);
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function dependencySearchTerms(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number") {
    const normalized = normalizeSearchText(String(value));
    return normalized ? [normalized] : [];
  }
  if (Array.isArray(value)) return value.flatMap(dependencySearchTerms);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(dependencySearchTerms);
  }
  return [];
}

function trigrams(value: string): Set<string> {
  const characters = Array.from(value);
  const result = new Set<string>();
  if (characters.length < 3) {
    if (value) result.add(value);
    return result;
  }
  for (let index = 0; index <= characters.length - 3; index += 1) {
    result.add(characters.slice(index, index + 3).join(""));
  }
  return result;
}

function snapshotCandidateScore(
  values: Record<string, string>,
  searchText: string,
  columns: KnowledgeColumn[],
  terms: string[],
  queryText: string,
  termTrigrams: Array<Set<string>>,
): number {
  const normalizedText = normalizeSearchText([
    searchText,
    ...Object.values(values),
  ].join(" "));
  const resultValues = columns
    .filter((column) => column.roles.includes("result"))
    .map((column) => normalizeSearchText(values[column.name] ?? ""))
    .filter(Boolean);
  const keywords = columns
    .filter((column) => column.roles.includes("keyword") || column.roles.includes("search"))
    .map((column) => normalizeSearchText(values[column.name] ?? ""))
    .filter(Boolean);
  let score = 0;
  score += resultValues.some((value) => queryText.includes(value)) ? 30 : 0;
  score += keywords.filter((keyword) => queryText.includes(keyword)).length * 20;
  score += terms.some((term) => normalizedText.includes(term)) ? 10 : 0;
  const textTrigrams = trigrams(normalizedText);
  for (const candidateTrigrams of termTrigrams) {
    for (const trigram of candidateTrigrams) {
      if (textTrigrams.has(trigram)) score += 1;
    }
  }
  return score;
}

function buildCacheKey(fieldId: string, knowledgeBaseId: string, query: string, candidates: KnowledgeCandidate[]) {
  return JSON.stringify({
    fieldId,
    knowledgeBaseId,
    query,
    candidates: candidates.map((candidate) => [candidate.itemId, candidate.score]),
  });
}

function filterPromptCandidates(
  candidates: KnowledgeCandidate[],
  searchableColumns: Set<string>,
): KnowledgeCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    values: Object.fromEntries(
      Object.entries(candidate.values)
        .filter(([column]) => searchableColumns.has(column)),
    ),
  }));
}

function reviewResult(
  fieldKey: string,
  errorMessage?: string,
  route?: ModelRouteResult,
): KnowledgeMatchExecutionResult {
  return {
    status: "needs_review",
    result: { [fieldKey]: "" },
    ...(errorMessage ? { errorMessage } : {}),
    ...(route ? { route } : {}),
  };
}

export interface KnowledgeMatchExecutionResult extends KnowledgeMatchResult {
  route?: ModelRouteResult;
  cached?: boolean;
}

export async function matchKnowledgeItem(input: {
  recordId: string;
  field: AnalysisField;
  sectionName: string;
  dependencies: Record<string, unknown>;
  knowledgeSnapshot?: SectionConfigVersion["knowledgeSnapshot"];
}): Promise<KnowledgeMatchExecutionResult> {
  return withModelBudget(() => matchKnowledgeWithinBudget(input));
}

async function matchKnowledgeWithinBudget(input: Parameters<typeof matchKnowledgeItem>[0]): Promise<KnowledgeMatchResult> {
  assertAnalysisActive(); checkModelBudget();
  if (!input.field.knowledgeBaseId) {
    return reviewResult(input.field.key, "知识匹配字段未配置知识库");
  }

  const snapshotBase = input.knowledgeSnapshot?.find((base) => base.id === input.field.knowledgeBaseId);
  const knowledgeBase = input.knowledgeSnapshot
    ? snapshotBase
    : getKnowledgeBase(input.field.knowledgeBaseId);
  if (!knowledgeBase) {
    return reviewResult(input.field.key, "知识库不存在");
  }

  const query = buildSearchQuery(input.dependencies);
  const snapshotTerms = dependencySearchTerms(input.dependencies);
  const snapshotQueryText = snapshotTerms.join("");
  const snapshotTermTrigrams = snapshotTerms.map(trigrams);
  const candidates = snapshotBase
    ? (Array.isArray(snapshotBase.items) ? snapshotBase.items : [])
      .filter((item) => item && typeof item === "object" && item.isEnabled !== false)
      .map((item) => {
        const values = item.values && typeof item.values === "object"
          ? Object.fromEntries(Object.entries(item.values).map(([key, value]) => [key, String(value ?? "")]))
          : {};
        const searchText = String(item.searchText ?? JSON.stringify(values));
        return {
          itemId: String(item.id ?? ""),
          values,
          score: snapshotCandidateScore(
            values,
            searchText,
            (Array.isArray(snapshotBase.columns) ? snapshotBase.columns : []) as KnowledgeColumn[],
            snapshotTerms,
            snapshotQueryText,
            snapshotTermTrigrams,
          ),
          matchedText: searchText,
        };
      })
      .filter((candidate) => candidate.itemId)
      .toSorted((left, right) => right.score - left.score || left.itemId.localeCompare(right.itemId))
      .slice(0, input.field.candidateLimit)
    : searchKnowledge({
      knowledgeBaseId: knowledgeBase.id as string,
      query,
      limit: input.field.candidateLimit,
    });
  if (!candidates.length) {
    return reviewResult(input.field.key, "本地知识库未召回候选");
  }
  const knowledgeBaseId = String(knowledgeBase.id);
  const cacheKey = buildCacheKey(input.field.id, knowledgeBaseId, query, candidates);
  const cached = matchCache.get(cacheKey);
  const cachedCandidate = cached && cached.expiresAt > Date.now()
    ? candidates.find((candidate) => candidate.itemId === cached.itemId)
    : undefined;
  if (cached && !cachedCandidate) matchCache.delete(cacheKey);
  const columns = (Array.isArray(knowledgeBase.columns) ? knowledgeBase.columns : []) as KnowledgeColumn[];
  const promptColumns = new Set(
    columns
      .filter((column) => (
        column.roles.some((role) => (
          role === "result"
          || role === "search"
          || role === "keyword"
          || role === "description"
          || role === "positive_example"
          || role === "negative_example"
        ))
      ))
      .map((column) => column.name),
  );
  const messages = buildKnowledgeMatchMessages({
    sectionName: input.sectionName,
    fieldPrompt: input.field.prompt,
    dependencies: input.dependencies,
    candidates: filterPromptCandidates(candidates, promptColumns),
  });
  let selected = cachedCandidate;
  let response: Awaited<ReturnType<typeof callModelPool>> | undefined;
  if (!selected) {
    const candidateIds = new Set(candidates.map((candidate) => candidate.itemId));
    response = await callModelPool(messages, {
      purpose: "text",
      recordId: input.recordId,
      fieldId: input.field.id,
      operation: "knowledge_match",
      validate: (content) => {
        const knowledgeItemId = parseKnowledgeItemId(content);
        return {
          valid: knowledgeItemId !== undefined
            && (knowledgeItemId === "" || candidateIds.has(knowledgeItemId)),
        };
      },
    });
    assertAnalysisActive();
    const knowledgeItemId = parseKnowledgeItemId(response.content);
    if (knowledgeItemId === "") return reviewResult(input.field.key, undefined, response);
    if (knowledgeItemId === undefined) {
      return reviewResult(input.field.key, "模型返回不是合法的知识候选 JSON", response);
    }
    selected = candidates.find((candidate) => candidate.itemId === knowledgeItemId);
    if (!selected) {
      return reviewResult(input.field.key, "模型返回了候选范围外的知识条目 ID", response);
    }
    matchCache.set(cacheKey, { itemId: selected.itemId, expiresAt: Date.now() + MATCH_CACHE_TTL_MS });
  }

  const snapshotId = crypto.randomUUID();
  assertRecordOwnership(input.recordId);
  db.prepare(`
    INSERT INTO knowledge_match_snapshots (
      id, record_id, field_id, knowledge_base_id, knowledge_item_id,
      item_values_json, candidate_snapshot_json, query_snapshot,
      model_response, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshotId,
    input.recordId,
    input.field.id,
    knowledgeBaseId,
    selected.itemId,
    JSON.stringify(selected.values),
    JSON.stringify(candidates),
    query,
    response?.raw ?? JSON.stringify({ cached: true }),
    new Date().toISOString(),
  );

  return {
    status: "completed",
    result: { [input.field.key]: selected.itemId },
    snapshotId,
    ...(response ? { route: response } : { cached: true }),
  };
}
