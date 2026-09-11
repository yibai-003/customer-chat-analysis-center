import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../../db/client";
import { config } from "../../config";
import type {
  KnowledgeBase,
  KnowledgeBaseInput,
  KnowledgeColumn,
  KnowledgeItem,
  KnowledgeItemInput,
  KnowledgeItemPage,
  KnowledgeItemQuery,
} from "../../../shared/types";

const now = () => new Date().toISOString();

function mapKnowledgeBase(row: any): KnowledgeBase {
  return {
    id: row.id,
    sectionId: row.section_id,
    name: row.name,
    originalFilename: row.original_filename,
    columns: JSON.parse(row.column_schema_json || "[]"),
    itemCount: row.item_count,
    isEnabled: Boolean(row.is_enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapKnowledgeItem(row: any): KnowledgeItem {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    values: JSON.parse(row.values_json || "{}"),
    isEnabled: Boolean(row.is_enabled),
    sourceRowNumber: row.source_row_number ?? undefined,
    updatedAt: row.updated_at,
  };
}

export function buildKnowledgePathKey(
  columns: KnowledgeColumn[],
  values: Record<string, string>,
): string {
  return JSON.stringify(
    columns
      .filter((column) => column.roles.includes("result"))
      .map((column) => values[column.name] ?? ""),
  );
}

export function buildKnowledgeSearchText(
  columns: KnowledgeColumn[],
  values: Record<string, string>,
): string {
  const roleWeights = [
    ["keyword", 4],
    ["result", 3],
    ["search", 2],
    ["description", 1],
    ["positive_example", 1],
    ["negative_example", 1],
  ] as const;
  const parts: string[] = [];

  for (const [role, weight] of roleWeights) {
    for (const column of columns) {
      const value = values[column.name]?.trim();
      if (!value || !column.roles.includes(role)) continue;
      for (let index = 0; index < weight; index += 1) {
        parts.push(value);
      }
    }
  }

  return parts.join(" ");
}

export function listKnowledgeBases(sectionId: string): KnowledgeBase[] {
  return (db.prepare(`
    SELECT *
    FROM knowledge_bases
    WHERE section_id = ?
    ORDER BY updated_at DESC, id
  `).all(sectionId) as any[]).map(mapKnowledgeBase);
}

export function getKnowledgeBase(id: string): KnowledgeBase | undefined {
  const row = db.prepare("SELECT * FROM knowledge_bases WHERE id = ?").get(id) as any;
  return row ? mapKnowledgeBase(row) : undefined;
}

export function upsertKnowledgeBase(input: KnowledgeBaseInput): KnowledgeBase {
  const existing = input.id ? getKnowledgeBase(input.id) : undefined;
  if (existing && existing.sectionId !== input.sectionId) {
    throw new Error("知识库不能移动到其他板块");
  }

  const id = input.id ?? crypto.randomUUID();
  const timestamp = now();
  db.prepare(`
    INSERT INTO knowledge_bases (
      id, section_id, name, original_filename, column_schema_json,
      item_count, is_enabled, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      original_filename = excluded.original_filename,
      column_schema_json = excluded.column_schema_json,
      is_enabled = excluded.is_enabled,
      updated_at = excluded.updated_at
  `).run(
    id,
    input.sectionId,
    input.name,
    input.originalFilename,
    JSON.stringify(input.columns),
    input.isEnabled ? 1 : 0,
    timestamp,
    timestamp,
  );
  return getKnowledgeBase(id)!;
}

export function deleteKnowledgeBase(id: string): void {
  const transaction = db.transaction(() => {
    const imports = db.prepare(`
      SELECT source_path
      FROM knowledge_imports
      WHERE knowledge_base_id = ?
    `).all(id) as Array<{ source_path: string | null }>;
    db.prepare("DELETE FROM knowledge_item_fts WHERE knowledge_base_id = ?").run(id);
    db.prepare("DELETE FROM knowledge_bases WHERE id = ?").run(id);
    const dataRoot = path.resolve(config.dataDir);
    for (const item of imports) {
      if (!item.source_path) continue;
      const sourcePath = path.resolve(item.source_path);
      if (sourcePath === dataRoot || !sourcePath.startsWith(`${dataRoot}${path.sep}`)) continue;
      try {
        fs.rmSync(sourcePath, { force: true });
      } catch {
        // Database deletion should not fail because an old source file is already gone.
      }
    }
  });
  transaction();
}

export function listKnowledgeItems(
  baseId: string,
  query: KnowledgeItemQuery = {},
): KnowledgeItemPage {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));
  const where = ["knowledge_base_id = ?"];
  const parameters: unknown[] = [baseId];

  if (query.enabled !== undefined) {
    where.push("is_enabled = ?");
    parameters.push(query.enabled ? 1 : 0);
  }
  if (query.search?.trim()) {
    where.push("(values_json LIKE ? OR search_text LIKE ?)");
    const pattern = `%${query.search.trim()}%`;
    parameters.push(pattern, pattern);
  }

  const whereSql = where.join(" AND ");
  const total = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM knowledge_items
    WHERE ${whereSql}
  `).get(...parameters) as { count: number }).count;
  const rows = db.prepare(`
    SELECT *
    FROM knowledge_items
    WHERE ${whereSql}
    ORDER BY updated_at DESC, id
    LIMIT ? OFFSET ?
  `).all(...parameters, pageSize, (page - 1) * pageSize) as any[];

  return {
    items: rows.map(mapKnowledgeItem),
    total,
    page,
    pageSize,
  };
}

export function getKnowledgeItem(id: string): KnowledgeItem | undefined {
  const row = db.prepare("SELECT * FROM knowledge_items WHERE id = ?").get(id) as any;
  return row ? mapKnowledgeItem(row) : undefined;
}

interface KnowledgeItemRecordInput extends KnowledgeItemInput {
  pathKey?: string;
  searchText?: string;
  sourceImportId?: string;
}

export function saveKnowledgeItemRecord(input: KnowledgeItemRecordInput): KnowledgeItem {
  if (!db.inTransaction) {
    throw new Error("知识条目和 FTS 必须在同一事务中更新");
  }
  const base = getKnowledgeBase(input.knowledgeBaseId);
  if (!base) throw new Error("知识库不存在");

  const pathKey = input.pathKey ?? buildKnowledgePathKey(base.columns, input.values);
  const searchText = input.searchText
    ?? buildKnowledgeSearchText(base.columns, input.values);
  const existingByPath = db.prepare(`
    SELECT id
    FROM knowledge_items
    WHERE knowledge_base_id = ? AND path_key = ?
  `).get(input.knowledgeBaseId, pathKey) as { id: string } | undefined;
  const existingById = input.id ? getKnowledgeItem(input.id) : undefined;
  if (existingById && existingById.knowledgeBaseId !== input.knowledgeBaseId) {
    throw new Error("知识条目不能移动到其他知识库");
  }

  const id = input.id ?? existingByPath?.id ?? crypto.randomUUID();
  const timestamp = now();
  db.prepare(`
    INSERT INTO knowledge_items (
      id, knowledge_base_id, path_key, values_json, search_text,
      is_enabled, source_import_id, source_row_number, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      path_key = excluded.path_key,
      values_json = excluded.values_json,
      search_text = excluded.search_text,
      is_enabled = excluded.is_enabled,
      source_import_id = COALESCE(excluded.source_import_id, knowledge_items.source_import_id),
      source_row_number = excluded.source_row_number,
      updated_at = excluded.updated_at
  `).run(
    id,
    input.knowledgeBaseId,
    pathKey,
    JSON.stringify(input.values),
    searchText,
    input.isEnabled ? 1 : 0,
    input.sourceImportId ?? null,
    input.sourceRowNumber ?? null,
    timestamp,
    timestamp,
  );
  db.prepare("DELETE FROM knowledge_item_fts WHERE item_id = ?").run(id);
  db.prepare(`
    INSERT INTO knowledge_item_fts (item_id, knowledge_base_id, search_text)
    VALUES (?, ?, ?)
  `).run(id, input.knowledgeBaseId, searchText);
  return getKnowledgeItem(id)!;
}

export function upsertKnowledgeItem(input: KnowledgeItemInput): KnowledgeItem {
  const transaction = db.transaction(() => {
    const item = saveKnowledgeItemRecord(input);
    db.prepare(`
      UPDATE knowledge_bases
      SET item_count = (
        SELECT COUNT(*) FROM knowledge_items WHERE knowledge_base_id = ?
      ), updated_at = ?
      WHERE id = ?
    `).run(input.knowledgeBaseId, now(), input.knowledgeBaseId);
    return item;
  });
  return transaction();
}

export function deleteKnowledgeItem(id: string): void {
  const transaction = db.transaction(() => {
    const item = getKnowledgeItem(id);
    if (!item) return;
    db.prepare("DELETE FROM knowledge_item_fts WHERE item_id = ?").run(id);
    db.prepare("DELETE FROM knowledge_items WHERE id = ?").run(id);
    db.prepare(`
      UPDATE knowledge_bases
      SET item_count = (
        SELECT COUNT(*) FROM knowledge_items WHERE knowledge_base_id = ?
      ), updated_at = ?
      WHERE id = ?
    `).run(item.knowledgeBaseId, now(), item.knowledgeBaseId);
  });
  transaction();
}
