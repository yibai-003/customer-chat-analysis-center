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
import { sectionBusinessRules } from "./section-business-rules";

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
    exportSettings: {
      outputColumns: fields
        .filter((field) => field.exportEnabled)
        .map((field) => ({ key: field.key, outputColumn: field.outputColumn ?? null })),
    },
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
    const timestamp = now();
    const sectionSnapshot = { ...version.sectionSnapshot, ...patch.sectionSnapshot };
    const fieldsSnapshot = patch.fieldsSnapshot ?? version.fieldsSnapshot;
    const exportSettings = patch.exportSettings ?? version.exportSettings;
    const dependenciesSnapshot = patch.dependenciesSnapshot ?? version.dependenciesSnapshot;
    const knowledgeSnapshot = patch.knowledgeSnapshot ?? version.knowledgeSnapshot;
    const businessRules = patch.businessRules ?? version.businessRules;
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
