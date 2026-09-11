import path from "node:path";
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { db } from "../../db/client";
import type {
  KnowledgeColumn,
  KnowledgeImportPreview,
  KnowledgeImportResult,
} from "../../../shared/types";
import {
  buildKnowledgePathKey,
  buildKnowledgeSearchText,
  getKnowledgeBase,
  listKnowledgeBases,
  saveKnowledgeItemRecord,
  upsertKnowledgeBase,
} from "./knowledge-repository";

export interface KnowledgeImportInput {
  filePath: string;
  originalFilename: string;
  sectionId: string;
  name?: string;
  columns?: KnowledgeColumn[];
  knowledgeBaseId?: string;
}

interface ParsedKnowledgeRow {
  rowNumber: number;
  values: Record<string, string>;
  pathKey: string;
  searchText: string;
}

interface WorkbookInspection {
  sheetName: string;
  headers: string[];
  columns: KnowledgeColumn[];
  totalRows: number;
  duplicateRows: number;
  errors: Array<{ rowNumber: number; message: string }>;
  rows: ParsedKnowledgeRow[];
}

function sameColumns(left: KnowledgeColumn[], right: KnowledgeColumn[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertSavedColumns(
  savedColumns: KnowledgeColumn[],
  suppliedColumns?: KnowledgeColumn[],
): void {
  if (suppliedColumns && !sameColumns(savedColumns, suppliedColumns)) {
    throw new Error("列映射与知识库已保存映射不一致");
  }
}

function stableJson(value: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function stableString(value: ExcelJS.CellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("result" in value) {
      return stableString(value.result as ExcelJS.CellValue);
    }
    if ("richText" in value) {
      return value.richText.map((part) => part.text).join("").trim();
    }
    if ("text" in value && typeof value.text === "string") {
      return value.text.trim();
    }
    if ("hyperlink" in value && typeof value.hyperlink === "string") {
      return value.hyperlink.trim();
    }
    if ("error" in value && typeof value.error === "string") {
      return value.error;
    }
  }
  return String(value).trim();
}

function rowValues(row: ExcelJS.Row): string[] {
  const values: string[] = [];
  for (let index = 1; index <= row.cellCount; index += 1) {
    values.push(stableString(row.getCell(index).value));
  }
  return values;
}

function isNonEmptyRow(row: ExcelJS.Row): boolean {
  return rowValues(row).some(Boolean);
}

function normalizeColumns(
  headers: string[],
  configured?: KnowledgeColumn[],
): KnowledgeColumn[] {
  const configuredByName = new Map<string, KnowledgeColumn>();
  for (const column of configured ?? []) {
    const name = column.name.trim();
    if (configuredByName.has(name)) {
      throw new Error(`列映射重复：${name}`);
    }
    if (!headers.includes(name)) {
      throw new Error(`列映射不存在于工作簿：${name}`);
    }
    configuredByName.set(name, { ...column, name });
  }

  const columns = headers.map((header) => configuredByName.get(header) ?? {
    name: header,
    roles: configured ? ["metadata"] : ["result", "search"],
  } satisfies KnowledgeColumn);
  if (!columns.some((column) => column.roles.includes("result"))) {
    throw new Error("至少配置一个结果列");
  }

  for (const column of columns) {
    if (column.requiredParent && !headers.includes(column.requiredParent)) {
      throw new Error(`父列不存在：${column.requiredParent}`);
    }
  }
  return columns;
}

async function inspectWorkbook(
  filePath: string,
  configuredColumns?: KnowledgeColumn[],
): Promise<WorkbookInspection> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets.find((candidate) => {
    let found = false;
    candidate.eachRow((row) => {
      if (!found && isNonEmptyRow(row)) found = true;
    });
    return found;
  });
  if (!worksheet) throw new Error("工作簿没有非空工作表");

  let headerRow: ExcelJS.Row | undefined;
  worksheet.eachRow((row) => {
    if (!headerRow && isNonEmptyRow(row)) headerRow = row;
  });
  if (!headerRow) throw new Error("表头不能为空");

  const headers = rowValues(headerRow);
  if (!headers.length || headers.some((header) => !header)) {
    throw new Error("表头不能为空");
  }
  if (new Set(headers).size !== headers.length) {
    throw new Error("表头重复");
  }

  const columns = normalizeColumns(headers, configuredColumns);
  const rowsByPath = new Map<string, ParsedKnowledgeRow>();
  const errors: Array<{ rowNumber: number; message: string }> = [];
  let totalRows = 0;
  let duplicateRows = 0;

  worksheet.eachRow((row) => {
    if (row.number <= headerRow!.number || !isNonEmptyRow(row)) return;
    totalRows += 1;
    const values = Object.fromEntries(
      headers.map((header, index) => [
        header,
        stableString(row.getCell(index + 1).value),
      ]),
    );
    const parentViolation = columns.find((column) => (
      column.requiredParent
      && values[column.name]
      && !values[column.requiredParent]
    ));
    if (parentViolation?.requiredParent) {
      errors.push({
        rowNumber: row.number,
        message: `列“${parentViolation.name}”有值时，父列“${parentViolation.requiredParent}”不能为空`,
      });
      return;
    }

    const pathKey = buildKnowledgePathKey(columns, values);
    if (rowsByPath.has(pathKey)) duplicateRows += 1;
    rowsByPath.set(pathKey, {
      rowNumber: row.number,
      values,
      pathKey,
      searchText: buildKnowledgeSearchText(columns, values),
    });
  });

  return {
    sheetName: worksheet.name,
    headers,
    columns,
    totalRows,
    duplicateRows,
    errors,
    rows: [...rowsByPath.values()],
  };
}

function resolvePreviewBaseId(
  sectionId: string,
  columns: KnowledgeColumn[],
  knowledgeBaseId?: string,
): string | undefined {
  if (knowledgeBaseId) {
    const base = getKnowledgeBase(knowledgeBaseId);
    if (!base) throw new Error("知识库不存在");
    if (base.sectionId !== sectionId) throw new Error("知识库不属于当前板块");
    return base.id;
  }

  const matching = listKnowledgeBases(sectionId).filter(
    (base) => sameColumns(base.columns, columns),
  );
  return matching.length === 1 ? matching[0].id : undefined;
}

function summarizeRows(
  inspection: WorkbookInspection,
  knowledgeBaseId?: string,
): Pick<KnowledgeImportPreview, "added" | "updated" | "skipped"> {
  if (!knowledgeBaseId) {
    return { added: inspection.rows.length, updated: 0, skipped: 0 };
  }

  const existingRows = db.prepare(`
    SELECT path_key, values_json
    FROM knowledge_items
    WHERE knowledge_base_id = ?
  `).all(knowledgeBaseId) as Array<{ path_key: string; values_json: string }>;
  const existingByPath = new Map(
    existingRows.map((row) => [
      row.path_key,
      stableJson(JSON.parse(row.values_json)),
    ]),
  );
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of inspection.rows) {
    const existing = existingByPath.get(row.pathKey);
    if (existing === undefined) added += 1;
    else if (existing === stableJson(row.values)) skipped += 1;
    else updated += 1;
  }
  return { added, updated, skipped };
}

export async function previewKnowledgeImport(
  filePath: string,
  originalFilename: string,
  sectionId: string,
  columns?: KnowledgeColumn[],
  knowledgeBaseId?: string,
): Promise<KnowledgeImportPreview> {
  void originalFilename;
  const base = knowledgeBaseId ? getKnowledgeBase(knowledgeBaseId) : undefined;
  if (base && base.sectionId !== sectionId) {
    throw new Error("知识库不属于当前板块");
  }
  if (base) assertSavedColumns(base.columns, columns);
  const inspection = await inspectWorkbook(
    filePath,
    base?.columns ?? columns,
  );
  if (base && !sameColumns(base.columns, inspection.columns)) {
    throw new Error("工作簿列结构与知识库已保存映射不一致");
  }
  const resolvedBaseId = resolvePreviewBaseId(
    sectionId,
    inspection.columns,
    knowledgeBaseId,
  );
  const summary = summarizeRows(inspection, resolvedBaseId);

  return {
    token: crypto.randomUUID(),
    headers: inspection.headers,
    totalRows: inspection.totalRows,
    ...summary,
    duplicateRows: inspection.duplicateRows,
    errors: inspection.errors,
  };
}

export async function importKnowledgeWorkbook(
  input: KnowledgeImportInput,
): Promise<KnowledgeImportResult> {
  const existingBase = input.knowledgeBaseId
    ? getKnowledgeBase(input.knowledgeBaseId)
    : undefined;
  if (input.knowledgeBaseId && !existingBase) throw new Error("知识库不存在");
  if (existingBase && existingBase.sectionId !== input.sectionId) {
    throw new Error("知识库不属于当前板块");
  }
  if (existingBase) assertSavedColumns(existingBase.columns, input.columns);

  const inspection = await inspectWorkbook(
    input.filePath,
    existingBase?.columns ?? input.columns,
  );
  if (existingBase && !sameColumns(existingBase.columns, inspection.columns)) {
    throw new Error("工作簿列结构与知识库已保存映射不一致");
  }
  if (inspection.errors.length) {
    throw new Error(inspection.errors.map(
      (error) => `第 ${error.rowNumber} 行：${error.message}`,
    ).join("；"));
  }

  const transaction = db.transaction(() => {
    const base = upsertKnowledgeBase({
      id: existingBase?.id,
      sectionId: input.sectionId,
      name: input.name ?? existingBase?.name
        ?? path.basename(input.originalFilename, path.extname(input.originalFilename)),
      originalFilename: input.originalFilename,
      columns: inspection.columns,
      isEnabled: existingBase?.isEnabled ?? true,
    });
    const summary = summarizeRows(inspection, base.id);
    const changedItemIds: string[] = [];

    for (const row of inspection.rows) {
      const existing = db.prepare(`
        SELECT id, values_json, is_enabled
        FROM knowledge_items
        WHERE knowledge_base_id = ? AND path_key = ?
      `).get(base.id, row.pathKey) as {
        id: string;
        values_json: string;
        is_enabled: number;
      } | undefined;
      if (existing && stableJson(JSON.parse(existing.values_json)) === stableJson(row.values)) {
        continue;
      }

      const item = saveKnowledgeItemRecord({
        id: existing?.id,
        knowledgeBaseId: base.id,
        values: row.values,
        isEnabled: existing ? Boolean(existing.is_enabled) : true,
        sourceRowNumber: row.rowNumber,
        pathKey: row.pathKey,
        searchText: row.searchText,
      });
      changedItemIds.push(item.id);
    }

    const importId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO knowledge_imports (
        id, knowledge_base_id, original_filename, source_path,
        sheet_name, summary_json, status, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)
    `).run(
      importId,
      base.id,
      input.originalFilename,
      input.filePath,
      inspection.sheetName,
      JSON.stringify({
        ...summary,
        totalRows: inspection.totalRows,
        duplicateRows: inspection.duplicateRows,
      }),
      timestamp,
    );
    for (const itemId of changedItemIds) {
      db.prepare(`
        UPDATE knowledge_items
        SET source_import_id = ?
        WHERE id = ?
      `).run(importId, itemId);
    }
    db.prepare(`
      UPDATE knowledge_bases
      SET item_count = (
        SELECT COUNT(*) FROM knowledge_items WHERE knowledge_base_id = ?
      ), updated_at = ?
      WHERE id = ?
    `).run(base.id, timestamp, base.id);

    return {
      knowledgeBase: getKnowledgeBase(base.id)!,
      ...summary,
    };
  });

  return transaction();
}
