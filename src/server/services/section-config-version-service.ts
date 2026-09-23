import crypto from "node:crypto";
import { db } from "../db/client";
import type {
  AnalysisField,
  AnalysisFieldType,
  AnalysisExecutionType,
  SectionConfigVersion,
  SectionConfigVersionPatch,
  SectionConfigVersionStatus,
} from "../../shared/types";
import {
  parseConfiguration,
  receptionBusinessRulesInput,
  sectionConfigVersionPatchInput,
} from "../security/configuration-input";
import { sectionBusinessRules } from "./section-business-rules";
import { sectionExportSettings } from "./section-export-settings";

const now = () => new Date().toISOString();

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapField(row: any): AnalysisField {
  return {
    id: row.id,
    sectionId: row.section_id,
    key: row.key,
    label: row.label,
    type: row.field_type as AnalysisFieldType,
    prompt: row.prompt,
    options: parseJson(row.options_json, []),
    outputColumn: row.output_column ?? undefined,
    required: row.is_required !== 0,
    imageEnabled: row.image_enabled !== 0,
    dependsOn: parseJson(row.depends_on_json, []),
    sortOrder: row.sort_order,
    isEnabled: row.is_enabled !== 0,
    executionType: row.execution_type as AnalysisExecutionType,
    exportEnabled: row.export_enabled !== 0,
    knowledgeBaseId: row.knowledge_base_id ?? undefined,
    candidateLimit: row.candidate_limit ?? 15,
    matchFieldKey: row.match_field_key ?? undefined,
    knowledgeColumn: row.knowledge_column ?? undefined,
    knowledgeSyncEnabled: row.knowledge_sync_enabled !== 0,
    knowledgeCaptureLimit: row.knowledge_capture_limit ?? 2,
  };
}

function buildCurrentSnapshot(sectionId: string) {
  const section = db.prepare("SELECT * FROM analysis_sections WHERE id = ?").get(sectionId) as any;
  if (!section) throw new Error("板块不存在");
  const fields = (db.prepare(
    "SELECT * FROM analysis_fields WHERE section_id = ? ORDER BY sort_order, key",
  ).all(sectionId) as any[]).map(mapField);
  const knowledge = (db.prepare(
    "SELECT * FROM knowledge_bases WHERE section_id = ? ORDER BY id",
  ).all(sectionId) as any[]).map((base) => ({
    id: base.id,
    sectionId: base.section_id,
    name: base.name,
    originalFilename: base.original_filename,
    columns: parseJson(base.column_schema_json, []),
    itemCount: base.item_count,
    isEnabled: base.is_enabled !== 0,
    createdAt: base.created_at,
    updatedAt: base.updated_at,
    items: (db.prepare(
      "SELECT * FROM knowledge_items WHERE knowledge_base_id = ? ORDER BY path_key, id",
    ).all(base.id) as any[]).map((item) => ({
      id: item.id,
      knowledgeBaseId: item.knowledge_base_id,
      pathKey: item.path_key,
      values: parseJson(item.values_json, {}),
      searchText: item.search_text,
      isEnabled: item.is_enabled !== 0,
      sourceImportId: item.source_import_id ?? null,
      sourceRowNumber: item.source_row_number ?? null,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    })),
  }));
  return {
    sectionSnapshot: {
      id: section.id,
      parentId: section.parent_id ?? null,
      name: section.name,
      prompt: section.prompt,
      outputSchema: parseJson(section.output_schema_json, []),
      sourceFields: parseJson(section.source_fields_json, []),
      imageEnabled: section.image_enabled !== 0,
      sortOrder: section.sort_order,
      isEnabled: section.is_enabled !== 0,
    },
    fieldsSnapshot: fields,
    exportSettings: sectionExportSettings(sectionId, fields),
    dependenciesSnapshot: fields.map((field) => ({ key: field.key, dependsOn: field.dependsOn })),
    knowledgeSnapshot: knowledge,
    businessRules: sectionBusinessRules(sectionId),
  };
}

function mapVersion(row: any): SectionConfigVersion {
  return {
    id: row.id,
    sectionId: row.section_id,
    versionNumber: row.version_number,
    status: row.status as SectionConfigVersionStatus,
    isCurrent: row.is_current !== 0,
    sectionSnapshot: parseJson(row.section_snapshot_json, {} as SectionConfigVersion["sectionSnapshot"]),
    fieldsSnapshot: parseJson(row.fields_snapshot_json, []),
    exportSettings: parseJson(row.export_settings_json, { outputColumns: [] }),
    dependenciesSnapshot: parseJson(row.dependencies_snapshot_json, []),
    knowledgeSnapshot: parseJson(row.knowledge_snapshot_json, []),
    businessRules: parseJson(row.business_rules_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at ?? undefined,
    archivedAt: row.archived_at ?? undefined,
  };
}

function assertNoRuntimeState(value: unknown, path = "version"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRuntimeState(item, `${path}.${index}`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
    if (/(?:apikey|credential|secret|quota|cooldown|health|providerconfig|modelconfig|consecutivefailures)/.test(normalized)) {
      throw new Error(`业务版本快照禁止包含模型运行态字段：${path}.${key}`);
    }
    assertNoRuntimeState(child, `${path}.${key}`);
  }
}

function validateVersionSnapshot(version: Pick<
  SectionConfigVersion,
  "sectionId" | "sectionSnapshot" | "fieldsSnapshot" | "exportSettings" | "dependenciesSnapshot" | "knowledgeSnapshot" | "businessRules"
>): void {
  const { sectionSnapshot, fieldsSnapshot, exportSettings, dependenciesSnapshot, knowledgeSnapshot, businessRules } = version;
  if (sectionSnapshot.id !== version.sectionId) throw new Error("版本板块 ID 与所属板块不一致");
  const fieldIds = new Set<string>();
  const fieldKeys = new Set<string>();
  for (const field of fieldsSnapshot) {
    if (field.sectionId !== version.sectionId) throw new Error(`字段不属于当前板块：${field.key}`);
    if (fieldIds.has(field.id)) throw new Error(`字段 ID 重复：${field.id}`);
    if (fieldKeys.has(field.key)) throw new Error(`字段 Key 重复：${field.key}`);
    fieldIds.add(field.id);
    fieldKeys.add(field.key);
  }
  const allowedDependencies = new Set([...fieldKeys, ...(sectionSnapshot.sourceFields ?? [])]);
  for (const field of fieldsSnapshot) {
    if (field.dependsOn.includes(field.key)) throw new Error(`字段不能依赖自身：${field.key}`);
    for (const dependency of field.dependsOn) {
      if (!allowedDependencies.has(dependency)) throw new Error(`依赖字段不存在：${field.key} -> ${dependency}`);
    }
  }
  const byKey = new Map(fieldsSnapshot.map((field) => [field.key, field]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visited.has(key)) return;
    if (visiting.has(key)) throw new Error(`循环依赖：${key}`);
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn ?? []) if (byKey.has(dependency)) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of fieldKeys) visit(key);

  const dependencyMap = new Map(dependenciesSnapshot.map((item) => [item.key, item.dependsOn]));
  for (const field of fieldsSnapshot) {
    if (JSON.stringify(dependencyMap.get(field.key) ?? []) !== JSON.stringify(field.dependsOn)) {
      throw new Error(`字段依赖快照不一致：${field.key}`);
    }
  }
  if (dependencyMap.size !== fieldsSnapshot.length) throw new Error("字段依赖快照存在重复或多余项目");
  const exportKeys = new Set(exportSettings.outputColumns.map((item) => item.key));
  if (exportKeys.size !== exportSettings.outputColumns.length) throw new Error("导出字段 Key 重复");
  const exportHeaders = new Set<string>();
  for (const column of exportSettings.outputColumns) {
    const source = column.source ?? "field_result";
    const format = column.format ?? "value";
    const header = column.outputColumn?.trim() ?? "";
    if (!header) throw new Error(`导出字段缺少目标表头：${column.key}`);
    if (exportHeaders.has(header)) throw new Error(`导出目标表头重复：${header}`);
    exportHeaders.add(header);
    if (source === "field_result" && !fieldKeys.has(column.key)) {
      throw new Error(`导出字段不存在：${column.key}`);
    }
    if (source !== "reception_quality" && format !== "value") {
      throw new Error(`导出字段格式与来源不匹配：${column.key}`);
    }
    if (source === "reception_quality" && format === "value") {
      throw new Error(`接待质检导出字段缺少结构化格式：${column.key}`);
    }
    if (source === "platform_name" && column.key !== "platform_name") {
      throw new Error("平台导出字段 Key 必须为 platform_name");
    }
    if (source === "conversation_id" && column.key !== "conversation_id") {
      throw new Error("会话 ID 导出字段 Key 必须为 conversation_id");
    }
  }

  const knowledgeIds = new Set(knowledgeSnapshot.map((item) => String(item.id ?? "")));
  for (const field of fieldsSnapshot) {
    if (field.executionType === "knowledge_match" && (!field.knowledgeBaseId || !knowledgeIds.has(field.knowledgeBaseId))) {
      throw new Error(`知识匹配字段知识库无效：${field.key}`);
    }
    if (field.executionType === "knowledge_extract") {
      const match = field.matchFieldKey ? byKey.get(field.matchFieldKey) : undefined;
      if (!match || match.executionType !== "knowledge_match" || !field.knowledgeColumn) {
        throw new Error(`知识提取字段配置不完整：${field.key}`);
      }
    }
  }

  if (version.sectionId === "reception" || businessRules.kind === "reception_quality") {
    const checked = parseConfiguration(receptionBusinessRulesInput, businessRules);
    const grades = new Set(checked.gradeThresholds.map((item) => item.grade));
    for (const grade of ["A", "B", "C", "D"] as const) {
      if (!grades.has(grade)) throw new Error(`接待质检缺少 ${grade} 级阈值`);
    }
    if (new Set(checked.issues.map((item) => item.id)).size !== checked.issues.length) {
      throw new Error("接待质检问题 ID 重复");
    }
    for (const issue of checked.issues) {
      if (issue.name.includes(",")) throw new Error(`接待质检问题名称不能包含英文逗号：${issue.name}`);
      if (issue.dimension.includes(",")) throw new Error(`接待质检问题维度不能包含英文逗号：${issue.dimension}`);
    }
    const resultColumns = new Set(checked.importContract.resultColumns);
    for (const field of checked.importContract.completeHistoricalResultRequiredColumns) {
      if (!resultColumns.has(field)) throw new Error(`完整历史结果必填字段不属于结果区：${field}`);
    }
    if (resultColumns.has(checked.importContract.imageColumn)) {
      throw new Error("聊天截图列不能属于结果区");
    }
    const screenshotFacts = fieldsSnapshot.find((field) => field.key === "截图内容总结" && field.isEnabled);
    if (!screenshotFacts
      || screenshotFacts.executionType !== "reception_screenshot_facts"
      || !screenshotFacts.imageEnabled
      || screenshotFacts.dependsOn.length > 0
      || !screenshotFacts.prompt.trim()) {
      throw new Error("接待质检截图事实字段必须启用严格视觉事实抽取、图片输入和版本提示词");
    }
    const unifiedQuality = fieldsSnapshot.find((field) => field.key === "统一质检分析" && field.isEnabled);
    if (!unifiedQuality
      || unifiedQuality.executionType !== "reception_quality_analysis"
      || unifiedQuality.imageEnabled
      || !unifiedQuality.dependsOn.includes("截图内容总结")
      || !unifiedQuality.prompt.trim()) {
      throw new Error("接待质检统一质检字段必须依赖截图事实并使用版本提示词");
    }
    if (exportSettings.rowMode !== "screenshot_records") {
      throw new Error("接待质检导出必须使用截图记录行模式");
    }
    const sourceColumns = new Map(exportSettings.outputColumns.map((column) => [
      `${column.source ?? "field_result"}:${column.format ?? "value"}`,
      column,
    ]));
    for (const required of [
      "platform_name:value",
      "conversation_id:value",
      "reception_quality:reception_issue_names_csv",
      "reception_quality:reception_issue_dimensions_csv",
      "reception_quality:reception_issue_deductions_csv",
      "reception_quality:reception_total_deduction",
      "reception_quality:reception_has_d_level",
      "reception_quality:reception_chat_quotes",
      "reception_quality:reception_evidence_explanations",
      "reception_quality:reception_reasons",
      "reception_quality:reception_suggestions",
      "reception_quality:reception_grade",
      "reception_quality:reception_review_required",
      "reception_quality:reception_start_time",
      "reception_quality:reception_round_count",
    ]) {
      if (!sourceColumns.has(required)) throw new Error(`接待质检导出契约缺少字段：${required}`);
    }
  }
  assertNoRuntimeState(version);
}

export function listSectionVersions(sectionId: string): SectionConfigVersion[] {
  return (db.prepare(`
    SELECT * FROM analysis_section_versions
    WHERE section_id = ?
    ORDER BY version_number DESC
  `).all(sectionId) as any[]).map(mapVersion);
}

export function getSectionVersion(id: string): SectionConfigVersion | undefined {
  const row = db.prepare("SELECT * FROM analysis_section_versions WHERE id = ?").get(id) as any;
  return row ? mapVersion(row) : undefined;
}

export function getJobSectionConfigVersion(jobId: string): SectionConfigVersion | undefined {
  const row = db.prepare(`
    SELECT v.*
    FROM jobs j
    JOIN analysis_section_versions v ON v.id = j.section_config_version_id
    WHERE j.id = ?
  `).get(jobId) as any;
  return row ? mapVersion(row) : undefined;
}

export function createDraftVersion(sectionId: string): SectionConfigVersion {
  return db.transaction(() => {
    const snapshot = buildCurrentSnapshot(sectionId);
    const next = db.prepare(
      "SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number FROM analysis_section_versions WHERE section_id = ?",
    ).get(sectionId) as { version_number: number };
    const timestamp = now();
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO analysis_section_versions
      (id, section_id, version_number, status, is_current, section_snapshot_json,
       fields_snapshot_json, export_settings_json, dependencies_snapshot_json,
       knowledge_snapshot_json, business_rules_json, created_at, updated_at)
      VALUES (?, ?, ?, 'draft', 0, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      sectionId,
      next.version_number,
      JSON.stringify(snapshot.sectionSnapshot),
      JSON.stringify(snapshot.fieldsSnapshot),
      JSON.stringify(snapshot.exportSettings),
      JSON.stringify(snapshot.dependenciesSnapshot),
      JSON.stringify(snapshot.knowledgeSnapshot),
      JSON.stringify(snapshot.businessRules),
      timestamp,
      timestamp,
    );
    return getSectionVersion(id)!;
  })();
}

export function publishSectionVersion(id: string): SectionConfigVersion {
  return db.transaction(() => {
    const version = getSectionVersion(id);
    if (!version) throw new Error("配置版本不存在");
    if (version.status !== "draft") throw new Error("只有草稿版本可以发布");
    validateVersionSnapshot(version);
    const timestamp = now();
    db.prepare("UPDATE analysis_section_versions SET is_current = 0, updated_at = ? WHERE section_id = ? AND is_current = 1")
      .run(timestamp, version.sectionId);
    db.prepare(`UPDATE analysis_section_versions
      SET status = 'published', is_current = 1, published_at = ?, updated_at = ?
      WHERE id = ? AND status = 'draft'`).run(timestamp, timestamp, id);
    return getSectionVersion(id)!;
  })();
}

export function updateDraftSectionVersion(id: string, patch: SectionConfigVersionPatch): SectionConfigVersion {
  return db.transaction(() => {
    const version = getSectionVersion(id);
    if (!version) throw new Error("配置版本不存在");
    if (version.status !== "draft") throw new Error("只有草稿版本可以编辑");
    patch = parseConfiguration(sectionConfigVersionPatchInput, patch) as SectionConfigVersionPatch;
    const timestamp = now();
    const sectionSnapshot = { ...version.sectionSnapshot, ...patch.sectionSnapshot, id: version.sectionId };
    const fieldsSnapshot = patch.fieldsSnapshot ?? version.fieldsSnapshot;
    const exportSettings = patch.exportSettings
      ?? (patch.fieldsSnapshot
        ? sectionExportSettings(version.sectionId, fieldsSnapshot)
        : version.exportSettings);
    const dependenciesSnapshot = patch.dependenciesSnapshot ?? (patch.fieldsSnapshot
      ? fieldsSnapshot.map((field) => ({ key: field.key, dependsOn: field.dependsOn }))
      : version.dependenciesSnapshot);
    const knowledgeSnapshot = patch.knowledgeSnapshot ?? version.knowledgeSnapshot;
    const businessRules = patch.businessRules ?? version.businessRules;
    validateVersionSnapshot({
      sectionId: version.sectionId,
      sectionSnapshot,
      fieldsSnapshot,
      exportSettings,
      dependenciesSnapshot,
      knowledgeSnapshot,
      businessRules,
    });
    db.prepare(`UPDATE analysis_section_versions
      SET section_snapshot_json = ?, fields_snapshot_json = ?, export_settings_json = ?,
          dependencies_snapshot_json = ?, knowledge_snapshot_json = ?, business_rules_json = ?,
          updated_at = ?
      WHERE id = ? AND status = 'draft'`).run(
      JSON.stringify(sectionSnapshot),
      JSON.stringify(fieldsSnapshot),
      JSON.stringify(exportSettings),
      JSON.stringify(dependenciesSnapshot),
      JSON.stringify(knowledgeSnapshot),
      JSON.stringify(businessRules),
      timestamp,
      id,
    );
    return getSectionVersion(id)!;
  })();
}

export function deleteDraftSectionVersion(id: string): void {
  db.transaction(() => {
    const version = getSectionVersion(id);
    if (!version) throw new Error("配置版本不存在");
    if (version.status !== "draft") throw new Error("只有草稿版本可以删除");
    db.prepare("DELETE FROM analysis_section_versions WHERE id = ? AND status = 'draft'").run(id);
  })();
}

export function archiveSectionVersion(id: string): SectionConfigVersion {
  return db.transaction(() => {
    const version = getSectionVersion(id);
    if (!version) throw new Error("配置版本不存在");
    if (version.status !== "published") throw new Error("只有已发布版本可以归档");
    if (version.isCurrent) throw new Error("当前启用版本不能直接归档，请先启用其他版本");
    const timestamp = now();
    db.prepare(`UPDATE analysis_section_versions
      SET status = 'archived', archived_at = ?, updated_at = ?
      WHERE id = ? AND status = 'published'`).run(timestamp, timestamp, id);
    return getSectionVersion(id)!;
  })();
}

export function restoreSectionVersion(id: string): SectionConfigVersion {
  return db.transaction(() => {
    const version = getSectionVersion(id);
    if (!version) throw new Error("配置版本不存在");
    if (version.status !== "archived") throw new Error("只有归档版本可以恢复");
    const timestamp = now();
    db.prepare(`UPDATE analysis_section_versions
      SET status = 'published', archived_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'archived'`).run(timestamp, id);
    return getSectionVersion(id)!;
  })();
}

export function activateSectionVersion(id: string): SectionConfigVersion {
  return db.transaction(() => {
    const version = getSectionVersion(id);
    if (!version) throw new Error("配置版本不存在");
    if (version.status !== "published") throw new Error("只有已发布版本可以启用");
    const timestamp = now();
    db.prepare("UPDATE analysis_section_versions SET is_current = 0, updated_at = ? WHERE section_id = ? AND is_current = 1")
      .run(timestamp, version.sectionId);
    db.prepare("UPDATE analysis_section_versions SET is_current = 1, updated_at = ? WHERE id = ?")
      .run(timestamp, id);
    return getSectionVersion(id)!;
  })();
}
