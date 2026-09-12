import crypto from "node:crypto";
import { db } from "../db/client";
import type { AnalysisField, AnalysisFieldInput, AnalysisFieldType } from "../../shared/types";
import { isHotTopicField } from "../../shared/hot-topic";

export type AnalysisFieldLike = Pick<
  AnalysisField,
  "id" | "sectionId" | "key" | "label" | "type" | "prompt" | "required" | "imageEnabled" | "dependsOn"
> & Partial<Pick<
  AnalysisField,
  | "sortOrder"
  | "isEnabled"
  | "executionType"
  | "exportEnabled"
  | "knowledgeBaseId"
  | "candidateLimit"
  | "matchFieldKey"
  | "knowledgeColumn"
  | "knowledgeSyncEnabled"
  | "knowledgeCaptureLimit"
>>;

const now = () => new Date().toISOString();

function mapField(row: any): AnalysisField {
  return {
    id: row.id,
    sectionId: row.section_id,
    key: row.key,
    label: row.label,
    type: row.field_type as AnalysisFieldType,
    prompt: row.prompt,
    options: JSON.parse(row.options_json || "[]"),
    outputColumn: row.output_column ?? undefined,
    required: Boolean(row.is_required),
    imageEnabled: Boolean(row.image_enabled),
    dependsOn: JSON.parse(row.depends_on_json || "[]"),
    sortOrder: row.sort_order,
    isEnabled: Boolean(row.is_enabled),
    executionType: row.execution_type ?? "ai",
    exportEnabled: row.export_enabled === undefined ? true : Boolean(row.export_enabled),
    knowledgeBaseId: row.knowledge_base_id ?? undefined,
    candidateLimit: row.candidate_limit ?? 15,
    matchFieldKey: row.match_field_key ?? undefined,
    knowledgeColumn: row.knowledge_column ?? undefined,
    knowledgeSyncEnabled: Boolean(row.knowledge_sync_enabled),
    knowledgeCaptureLimit: row.knowledge_capture_limit ?? 2,
  };
}

export function listFields(sectionId: string): AnalysisField[] {
  return (db.prepare("SELECT * FROM analysis_fields WHERE section_id = ? ORDER BY sort_order, key").all(sectionId) as any[]).map(mapField);
}

export function getField(id: string): AnalysisField | undefined {
  const row = db.prepare("SELECT * FROM analysis_fields WHERE id = ?").get(id) as any;
  return row ? mapField(row) : undefined;
}

export function validateFieldGraph(fields: AnalysisFieldLike[], sourceFields: string[] = []): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const field of fields) {
    if (keys.has(field.key)) errors.push(`字段 Key 重复：${field.key}`);
    keys.add(field.key);
  }
  for (const field of fields) {
    if (field.knowledgeSyncEnabled && (!isHotTopicField(field) || field.type !== "string")) {
      errors.push(`知识沉淀仅支持热点话题板块的高频问题文本字段：${field.key}`);
    }
    if (field.knowledgeSyncEnabled && !field.dependsOn.length) errors.push(`知识沉淀必须依赖截图解析或客户问题：${field.key}`);
    if (field.knowledgeCaptureLimit !== undefined && ![1, 2].includes(field.knowledgeCaptureLimit)) {
      errors.push(`单次问题数必须为 1 或 2：${field.key}`);
    }
    if (field.executionType === "knowledge_match" && !field.knowledgeBaseId) {
      errors.push(`知识匹配字段未选择知识库：${field.key}`);
    }
    if (field.executionType === "knowledge_match" && field.knowledgeBaseId) {
      const knowledgeBase = db.prepare("SELECT section_id FROM knowledge_bases WHERE id = ?").get(field.knowledgeBaseId) as
        | { section_id: string }
        | undefined;
      if (!knowledgeBase || knowledgeBase.section_id !== field.sectionId) {
        errors.push(`知识匹配字段知识库不属于当前板块：${field.key}`);
      }
    }
    if (field.executionType === "knowledge_extract" && (!field.matchFieldKey || !field.knowledgeColumn)) {
      errors.push(`知识提取字段配置不完整：${field.key}`);
    }
    if (field.executionType === "knowledge_extract" && field.matchFieldKey) {
      const matchField = fields.find((candidate) => (
        candidate.key === field.matchFieldKey
        && candidate.sectionId === field.sectionId
        && candidate.executionType === "knowledge_match"
      ));
      if (!matchField) errors.push(`知识提取字段匹配来源无效：${field.key}`);
    }
    if (field.dependsOn.includes(field.key)) errors.push(`字段不能依赖自身：${field.key}`);
    for (const dependency of field.dependsOn) {
      const target = fields.find((candidate) => candidate.key === dependency);
      if (!target && !sourceFields.includes(dependency)) errors.push(`依赖字段不存在：${field.key} -> ${dependency}`);
      else if (target && target.sectionId !== field.sectionId) errors.push(`禁止跨板块依赖：${field.key} -> ${dependency}`);
    }
  }
  return errors;
}

export function topologicalFields(fields: AnalysisFieldLike[], sourceFields: string[] = []): AnalysisFieldLike[] {
  const errors = validateFieldGraph(fields, sourceFields);
  if (errors.length) throw new Error(errors.join("；"));
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: AnalysisFieldLike[] = [];
  const visit = (key: string) => {
    if (visited.has(key)) return;
    if (visiting.has(key)) throw new Error(`循环依赖：${key}`);
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn ?? []) if (byKey.has(dependency)) visit(dependency);
    visiting.delete(key);
    visited.add(key);
    result.push(byKey.get(key)!);
  };
  [...fields].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).forEach((field) => visit(field.key));
  return result;
}

export function upsertField(input: AnalysisFieldInput): AnalysisField {
  const section = db.prepare("SELECT prompt, image_enabled, source_fields_json FROM analysis_sections WHERE id = ?").get(input.sectionId) as any;
  if (!section) throw new Error("板块不存在");
  const existing = input.id ? getField(input.id) : undefined;
  const executionType = input.executionType ?? existing?.executionType ?? "ai";
  if (input.knowledgeSyncEnabled && !isHotTopicField({ ...input, executionType })) {
    throw new Error("知识沉淀仅支持热点话题板块的高频问题 AI 字段");
  }
  const requestedMatchFieldKey = input.matchFieldKey ?? existing?.matchFieldKey;
  const matchFieldKey = executionType === "knowledge_extract" ? requestedMatchFieldKey : undefined;
  const dependsOn = input.dependsOn ?? existing?.dependsOn ?? [];
  const dependenciesWithoutOldMatch = existing?.executionType === "knowledge_extract"
    && existing.matchFieldKey
    && existing.matchFieldKey !== matchFieldKey
    ? dependsOn.filter((dependency) => dependency !== existing.matchFieldKey)
    : dependsOn;
  const normalizedDependencies = executionType === "knowledge_extract" && matchFieldKey
    ? [...new Set([...dependenciesWithoutOldMatch, matchFieldKey])]
    : dependenciesWithoutOldMatch;
  const applicableMatchFieldKey = executionType === "knowledge_extract" ? matchFieldKey : undefined;
  const applicableKnowledgeColumn = executionType === "knowledge_extract" ? input.knowledgeColumn ?? existing?.knowledgeColumn : undefined;
  const applicableKnowledgeBaseId = executionType === "knowledge_match" ? input.knowledgeBaseId ?? existing?.knowledgeBaseId : undefined;
  const field: AnalysisField = {
    id: input.id ?? crypto.randomUUID(),
    sectionId: input.sectionId,
    key: input.key,
    label: input.label,
    type: input.type,
    prompt: input.prompt ?? section.prompt,
    options: input.options ?? existing?.options ?? [],
    outputColumn: input.outputColumn ?? existing?.outputColumn ?? input.label,
    required: input.required ?? false,
    imageEnabled: input.imageEnabled ?? (section.image_enabled !== 0),
    dependsOn: normalizedDependencies,
    sortOrder: input.sortOrder ?? existing?.sortOrder ?? listFields(input.sectionId).length,
    isEnabled: input.isEnabled ?? true,
    executionType,
    exportEnabled: input.exportEnabled ?? existing?.exportEnabled ?? (executionType !== "knowledge_match"),
    knowledgeBaseId: applicableKnowledgeBaseId,
    candidateLimit: input.candidateLimit ?? existing?.candidateLimit ?? 15,
    matchFieldKey: applicableMatchFieldKey,
    knowledgeColumn: applicableKnowledgeColumn,
    knowledgeSyncEnabled: isHotTopicField({ ...input, executionType }) && (input.knowledgeSyncEnabled ?? existing?.knowledgeSyncEnabled ?? false),
    knowledgeCaptureLimit: (input.knowledgeCaptureLimit ?? existing?.knowledgeCaptureLimit ?? 2) as 1 | 2,
  };
  const errors = validateFieldGraph(
    [...listFields(input.sectionId).filter((item) => item.id !== field.id), field],
    JSON.parse(section.source_fields_json || "[]"),
  );
  if (errors.length) throw new Error(errors.join("；"));
  const timestamp = now();
  db.prepare(`INSERT INTO analysis_fields
    (id,section_id,key,label,field_type,prompt,options_json,output_column,is_required,image_enabled,depends_on_json,sort_order,
     execution_type,export_enabled,knowledge_base_id,candidate_limit,match_field_key,knowledge_column,knowledge_sync_enabled,knowledge_capture_limit,is_enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET section_id=excluded.section_id,key=excluded.key,label=excluded.label,
      field_type=excluded.field_type,prompt=excluded.prompt,options_json=excluded.options_json,output_column=excluded.output_column,is_required=excluded.is_required,
      image_enabled=excluded.image_enabled,depends_on_json=excluded.depends_on_json,
      execution_type=excluded.execution_type,export_enabled=excluded.export_enabled,knowledge_base_id=excluded.knowledge_base_id,
      candidate_limit=excluded.candidate_limit,match_field_key=excluded.match_field_key,knowledge_column=excluded.knowledge_column,
      knowledge_sync_enabled=excluded.knowledge_sync_enabled,knowledge_capture_limit=excluded.knowledge_capture_limit,
      sort_order=excluded.sort_order,is_enabled=excluded.is_enabled,updated_at=excluded.updated_at`)
    .run(field.id, field.sectionId, field.key, field.label, field.type, field.prompt, JSON.stringify(field.options), field.outputColumn ?? null, field.required ? 1 : 0,
      field.imageEnabled ? 1 : 0, JSON.stringify(field.dependsOn), field.sortOrder, field.executionType, field.exportEnabled ? 1 : 0,
      field.knowledgeBaseId ?? null, field.candidateLimit, field.matchFieldKey ?? null, field.knowledgeColumn ?? null,
      field.knowledgeSyncEnabled ? 1 : 0, field.knowledgeCaptureLimit, field.isEnabled ? 1 : 0,
      timestamp, timestamp);
  return getField(field.id)!;
}

export function deleteField(id: string): void {
  db.prepare("DELETE FROM analysis_fields WHERE id = ?").run(id);
}

export function migrateLegacySectionFields(): void {
  const sections = db.prepare("SELECT id FROM analysis_sections").all() as Array<{ id: string }>;
  for (const section of sections) if (!listFields(section.id).length) {
    const row = db.prepare("SELECT output_schema_json, prompt, image_enabled FROM analysis_sections WHERE id = ?").get(section.id) as any;
    for (const [index, field] of (JSON.parse(row.output_schema_json || "[]") as any[]).entries()) {
      upsertField({ sectionId: section.id, key: field.key, label: field.label, type: field.type, prompt: row.prompt, required: field.required, imageEnabled: row.image_enabled !== 0, sortOrder: index });
    }
  }
}
