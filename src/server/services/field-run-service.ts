import { assertRecordOwnership } from "./run-ownership";
import crypto from "node:crypto";
import { db } from "../db/client";
import { listFields } from "./field-config-service";
import type { AnalysisField, AnalysisFieldRun } from "../../shared/types";

const json = (value: unknown) => JSON.stringify(value ?? {});
const now = () => new Date().toISOString();

function mapRun(row: any): AnalysisFieldRun {
  return {
    id: row.id,
    recordId: row.record_id,
    fieldId: row.field_id,
    sectionId: row.section_id,
    fieldKey: row.field_key,
    status: row.status,
    result: JSON.parse(row.result_json || "{}"),
    evidence: row.evidence_text ?? undefined,
    dependencies: JSON.parse(row.dependencies_json || "{}"),
    promptSnapshot: row.prompt_snapshot,
    fieldSnapshot: JSON.parse(row.field_snapshot_json || "{}"),
    modelConfigSnapshot: JSON.parse(row.model_config_snapshot_json || "{}"),
    rawResponse: row.raw_response ?? undefined,
    errorMessage: row.error_message ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    inputTokens: row.input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    createdAt: row.created_at,
  };
}

export function createFieldRun(input: {
  recordId: string;
  fieldId: string;
  status: AnalysisFieldRun["status"];
  result?: Record<string, unknown>;
  evidence?: string;
  dependencies?: Record<string, unknown>;
  promptSnapshot?: string;
  fieldSnapshot?: unknown;
  modelConfigSnapshot?: unknown;
  rawResponse?: string;
  errorMessage?: string;
  durationMs?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}): AnalysisFieldRun {
  assertRecordOwnership(input.recordId);
  const liveField = db.prepare(`SELECT f.*, s.id AS section_id FROM analysis_fields f
    JOIN analysis_sections s ON s.id = f.section_id WHERE f.id = ?`).get(input.fieldId) as any;
  const snapshotField = input.fieldSnapshot && typeof input.fieldSnapshot === "object"
    ? input.fieldSnapshot as Partial<AnalysisField>
    : undefined;
  if (!liveField && (!snapshotField?.sectionId || !snapshotField.key)) throw new Error("解析字段不存在");
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO analysis_field_runs
    (id,record_id,field_id,status,result_json,dependencies_json,evidence_text,prompt_snapshot,field_snapshot_json,
     model_config_snapshot_json,raw_response,error_message,duration_ms,input_tokens,output_tokens,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.recordId, input.fieldId, input.status, json(input.result), json(input.dependencies), input.evidence ?? null,
    input.promptSnapshot ?? snapshotField?.prompt ?? liveField.prompt,
    json(input.fieldSnapshot ?? liveField),
    json(input.modelConfigSnapshot),
    input.rawResponse ?? null, input.errorMessage ?? null, input.durationMs ?? null,
    input.usage?.prompt_tokens ?? null, input.usage?.completion_tokens ?? null, now(),
  );
  return listFieldRuns(input.recordId, snapshotField?.sectionId ?? liveField.section_id).find((run) => run.id === id)!;
}

export function listFieldRuns(recordId: string, sectionId?: string): AnalysisFieldRun[] {
  const rows = db.prepare(`SELECT r.*,
      COALESCE(json_extract(r.field_snapshot_json, '$.sectionId'), f.section_id) AS section_id,
      COALESCE(json_extract(r.field_snapshot_json, '$.key'), f.key) AS field_key
    FROM analysis_field_runs r
    LEFT JOIN analysis_fields f ON f.id = r.field_id
    WHERE r.record_id = ? ${sectionId ? "AND COALESCE(json_extract(r.field_snapshot_json, '$.sectionId'), f.section_id) = ?" : ""}
    ORDER BY r.created_at DESC, r.rowid DESC`).all(...(sectionId ? [recordId, sectionId] : [recordId])) as any[];
  return rows.map(mapRun);
}

export function getFieldResultContext(
  recordId: string,
  fieldKeys: string[],
  sectionId?: string,
): Record<string, unknown> {
  if (!fieldKeys.length) return {};
  const placeholders = fieldKeys.map(() => "?").join(",");
  const rows = db.prepare(`WITH ranked AS (
    SELECT r.result_json, r.status,
      COALESCE(json_extract(r.field_snapshot_json, '$.key'), f.key) AS key,
      ROW_NUMBER() OVER (PARTITION BY r.field_id ORDER BY r.created_at DESC, r.rowid DESC) AS position
    FROM analysis_field_runs r
    LEFT JOIN analysis_fields f ON f.id = r.field_id
    WHERE r.record_id = ? ${sectionId ? "AND COALESCE(json_extract(r.field_snapshot_json, '$.sectionId'), f.section_id) = ?" : ""}
      AND COALESCE(json_extract(r.field_snapshot_json, '$.key'), f.key) IN (${placeholders})
  )
  SELECT result_json, key FROM ranked
  WHERE position = 1 AND status IN ('completed','needs_review')`)
    .all(...(sectionId ? [recordId, sectionId, ...fieldKeys] : [recordId, ...fieldKeys])) as any[];
  const result: Record<string, unknown> = {};
  for (const row of rows) if (result[row.key] === undefined) {
    const parsed = JSON.parse(row.result_json || "{}");
    result[row.key] = parsed[row.key] ?? parsed;
  }
  return result;
}

export function getFieldResultContextForFields(
  recordId: string,
  fields: AnalysisField[],
): Record<string, unknown> {
  if (!fields.length) return {};
  const latest = listFieldRuns(recordId);
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const run = latest.find((item) => item.fieldId === field.id);
    if (!run || (run.status !== "completed" && run.status !== "needs_review")) continue;
    result[field.key] = run.result[field.key] ?? run.result;
  }
  return result;
}

export function aggregateFieldResults(recordId: string, sectionId: string): Record<string, unknown> {
  const fields = listFields(sectionId);
  return aggregateFieldResultsForFields(recordId, fields);
}

export function aggregateFieldResultsForFields(
  recordId: string,
  fields: AnalysisField[],
): Record<string, unknown> {
  const latest = listFieldRuns(recordId);
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const run = latest.find((item) => item.fieldId === field.id);
    if (run && (run.status === "completed" || run.status === "needs_review")) Object.assign(result, run.result);
  }
  return result;
}
