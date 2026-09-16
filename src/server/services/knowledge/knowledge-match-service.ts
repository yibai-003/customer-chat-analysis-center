import { assertRecordOwnership } from "../run-ownership";
import { checkModelBudget, withModelBudget } from "../../ai/model-budget";
import { assertAnalysisActive } from "../analysis-cancellation";
import crypto from "node:crypto";
import { db } from "../../db/client";
import type {
  AnalysisField,
  KnowledgeCandidate,
  KnowledgeMatchResult,
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
): KnowledgeMatchResult {
  return {
    status: "needs_review",
    result: { [fieldKey]: "" },
    ...(errorMessage ? { errorMessage } : {}),
  };
}

export async function matchKnowledgeItem(input: {
  recordId: string;
  field: AnalysisField;
  sectionName: string;
  dependencies: Record<string, unknown>;
}): Promise<KnowledgeMatchResult> {
  return withModelBudget(() => matchKnowledgeWithinBudget(input));
}

async function matchKnowledgeWithinBudget(input: Parameters<typeof matchKnowledgeItem>[0]): Promise<KnowledgeMatchResult> {
  assertAnalysisActive(); checkModelBudget();
  if (!input.field.knowledgeBaseId) {
    return reviewResult(input.field.key, "知识匹配字段未配置知识库");
  }

  const knowledgeBase = getKnowledgeBase(input.field.knowledgeBaseId);
  if (!knowledgeBase) {
    return reviewResult(input.field.key, "知识库不存在");
  }

  const query = buildSearchQuery(input.dependencies);
  const candidates = searchKnowledge({
    knowledgeBaseId: knowledgeBase.id,
    query,
    limit: input.field.candidateLimit,
  });
  if (!candidates.length) {
    return reviewResult(input.field.key, "本地知识库未召回候选");
  }
  const cacheKey = buildCacheKey(input.field.id, knowledgeBase.id, query, candidates);
  const cached = matchCache.get(cacheKey);
  const cachedCandidate = cached && cached.expiresAt > Date.now()
    ? candidates.find((candidate) => candidate.itemId === cached.itemId)
    : undefined;
  if (cached && !cachedCandidate) matchCache.delete(cacheKey);
  const promptColumns = new Set(
    knowledgeBase.columns
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
    response = await callModelPool(messages, {
      purpose: "text",
      recordId: input.recordId,
      fieldId: input.field.id,
      operation: "knowledge_match",
    });
    assertAnalysisActive();
    const knowledgeItemId = parseKnowledgeItemId(response.content);
    if (knowledgeItemId === "") return reviewResult(input.field.key);
    if (knowledgeItemId === undefined) return reviewResult(input.field.key, "模型返回不是合法的知识候选 JSON");
    selected = candidates.find((candidate) => candidate.itemId === knowledgeItemId);
    if (!selected) return reviewResult(input.field.key, "模型返回了候选范围外的知识条目 ID");
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
    knowledgeBase.id,
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
  };
}
