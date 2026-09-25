import { db } from "../../db/client";
import type {
  KnowledgeCandidate,
  KnowledgeColumn,
} from "../../../shared/types";

export interface KnowledgeSearchInput {
  knowledgeBaseId: string;
  query: string;
  limit?: number;
}

interface SearchRow {
  item_id: string;
  values_json: string;
  search_text: string;
  fts_score: number;
}

interface RankedRow extends SearchRow {
  values: Record<string, string>;
  score: number;
}

const DEFAULT_LIMIT = 15;
const MIN_LIMIT = 5;
const MAX_LIMIT = 30;
const MAX_CANDIDATE_POOL = 120;

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[ \t\r\n]+/g, "");
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(limit)));
}

function buildFtsQuery(query: string): string | undefined {
  const characters = Array.from(normalizeText(query));
  if (characters.length < 3) return undefined;

  const trigrams = new Set<string>();
  for (let index = 0; index <= characters.length - 3; index += 1) {
    trigrams.add(characters.slice(index, index + 3).join(""));
  }

  return Array.from(trigrams)
    .map((term) => `"${term.replaceAll("\"", "\"\"")}"`)
    .join(" OR ");
}

function getRoleValues(
  columns: KnowledgeColumn[],
  values: Record<string, string>,
  role: "result" | "keyword",
): string[] {
  return columns
    .filter((column) => column.roles.includes(role))
    .map((column) => values[column.name]?.trim())
    .filter((value): value is string => Boolean(value));
}

function calculateScore(
  row: SearchRow,
  columns: KnowledgeColumn[],
  normalizedQuery: string,
): RankedRow {
  const values = JSON.parse(row.values_json || "{}") as Record<string, string>;
  const resultValues = getRoleValues(columns, values, "result")
    .map(normalizeText);
  const keywords = getRoleValues(columns, values, "keyword")
    .map(normalizeText);
  const normalizedSearchText = normalizeText(row.search_text);
  let score = row.fts_score;

  score += resultValues.some((value) => normalizedQuery.includes(value)) ? 30 : 0;
  score += keywords.filter((keyword) => normalizedQuery.includes(keyword)).length * 20;
  score += normalizedSearchText.includes(normalizedQuery) ? 10 : 0;

  return { ...row, values, score };
}

export function searchKnowledge(input: KnowledgeSearchInput): KnowledgeCandidate[] {
  const query = input.query.trim();
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  const limit = clampLimit(input.limit);
  const candidateLimit = Math.min(
    MAX_CANDIDATE_POOL,
    Math.max(MAX_LIMIT, limit * 4),
  );
  const base = db.prepare(`
    SELECT column_schema_json
    FROM knowledge_bases
    WHERE id = ? AND is_enabled = 1
  `).get(input.knowledgeBaseId) as { column_schema_json: string } | undefined;
  if (!base) return [];

  const candidates = new Map<string, SearchRow>();
  const ftsQuery = buildFtsQuery(query);
  if (ftsQuery) {
    const rows = db.prepare(`
      SELECT
        items.id AS item_id,
        items.values_json,
        items.search_text,
        -bm25(knowledge_item_fts) AS fts_score
      FROM knowledge_item_fts
      JOIN knowledge_items AS items
        ON items.id = knowledge_item_fts.item_id
        AND items.knowledge_base_id = knowledge_item_fts.knowledge_base_id
      JOIN knowledge_bases AS bases
        ON bases.id = items.knowledge_base_id
      WHERE knowledge_item_fts MATCH ?
        AND knowledge_item_fts.knowledge_base_id = ?
        AND items.knowledge_base_id = ?
        AND items.is_enabled = 1
        AND bases.is_enabled = 1
      ORDER BY bm25(knowledge_item_fts), items.id
      LIMIT ?
    `).all(
      ftsQuery,
      input.knowledgeBaseId,
      input.knowledgeBaseId,
      candidateLimit,
    ) as SearchRow[];
    for (const row of rows) candidates.set(row.item_id, row);
  }

  if (Array.from(normalizedQuery).length < 3) {
    const rows = db.prepare(`
      SELECT
        items.id AS item_id,
        items.values_json,
        items.search_text,
        0 AS fts_score
      FROM knowledge_items AS items
      JOIN knowledge_bases AS bases
        ON bases.id = items.knowledge_base_id
      WHERE items.knowledge_base_id = ?
        AND items.is_enabled = 1
        AND bases.is_enabled = 1
        AND instr(
          lower(
            replace(
              replace(
                replace(
                  replace(items.search_text, ' ', ''),
                  char(9),
                  ''
                ),
                char(10),
                ''
              ),
              char(13),
              ''
            )
          ),
          ?
        ) > 0
      ORDER BY items.id
      LIMIT ?
    `).all(
      input.knowledgeBaseId,
      normalizedQuery,
      candidateLimit,
    ) as SearchRow[];
    for (const row of rows) {
      if (!candidates.has(row.item_id)) candidates.set(row.item_id, row);
    }
  }

  const columns = JSON.parse(base.column_schema_json || "[]") as KnowledgeColumn[];
  return Array.from(candidates.values())
    .map((row) => calculateScore(row, columns, normalizedQuery))
    .toSorted((left, right) => right.score - left.score || left.item_id.localeCompare(right.item_id))
    .slice(0, limit)
    .map((row) => ({
      itemId: row.item_id,
      values: row.values,
      score: row.score,
      matchedText: row.search_text,
    }));
}
