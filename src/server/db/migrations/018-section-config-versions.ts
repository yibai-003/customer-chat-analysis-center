import crypto from "node:crypto";
import { sectionBusinessRules } from "../../services/section-business-rules";

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function parseJson(value: unknown, fallback: unknown) {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export interface SectionConfigV1MigrationReport {
  succeeded: number;
  skipped: number;
  errors: Array<{ sectionId: string; message: string }>;
}

export let lastSectionConfigV1MigrationReport: SectionConfigV1MigrationReport = {
  succeeded: 0,
  skipped: 0,
  errors: [],
};

function buildSnapshot(db: any, section: any) {
  const fields = (db.prepare(
    "SELECT * FROM analysis_fields WHERE section_id = ? ORDER BY sort_order, key",
  ).all(section.id) as any[]).map((field) => ({
    id: field.id,
    sectionId: field.section_id,
    key: field.key,
    label: field.label,
    type: field.field_type,
    prompt: field.prompt,
    options: parseJson(field.options_json, []),
    outputColumn: field.output_column ?? null,
    required: field.is_required !== 0,
    imageEnabled: field.image_enabled !== 0,
    dependsOn: parseJson(field.depends_on_json, []),
    sortOrder: field.sort_order,
    executionType: field.execution_type,
    exportEnabled: field.export_enabled !== 0,
    knowledgeBaseId: field.knowledge_base_id ?? null,
    candidateLimit: field.candidate_limit ?? 15,
    matchFieldKey: field.match_field_key ?? null,
    knowledgeColumn: field.knowledge_column ?? null,
    knowledgeSyncEnabled: field.knowledge_sync_enabled !== 0,
    knowledgeCaptureLimit: field.knowledge_capture_limit ?? 2,
    isEnabled: field.is_enabled !== 0,
  }));
  const knowledge = (db.prepare(
    "SELECT * FROM knowledge_bases WHERE section_id = ? ORDER BY id",
  ).all(section.id) as any[]).map((base) => ({
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
  const sectionSnapshot = {
    id: section.id,
    parentId: section.parent_id ?? null,
    name: section.name,
    prompt: section.prompt,
    outputSchema: parseJson(section.output_schema_json, []),
    sourceFields: parseJson(section.source_fields_json, []),
    imageEnabled: section.image_enabled !== 0,
    sortOrder: section.sort_order,
    isEnabled: section.is_enabled !== 0,
  };
  return {
    sectionSnapshot,
    fields,
    exportSettings: {
      outputColumns: fields
        .filter((field) => field.exportEnabled)
        .map((field) => ({ key: field.key, outputColumn: field.outputColumn })),
    },
    dependencies: fields.map((field) => ({ key: field.key, dependsOn: field.dependsOn })),
    knowledge,
    businessRules: sectionBusinessRules(section.id),
  };
}

function detachFieldRunsFromLiveFields(db: any) {
  const foreignKeys = db.prepare("PRAGMA foreign_key_list(analysis_field_runs)").all() as Array<{ table: string }>;
  if (!foreignKeys.some((foreignKey) => foreignKey.table === "analysis_fields")) return;
  db.exec(`
    ALTER TABLE analysis_field_runs RENAME TO analysis_field_runs_before_v18;
    CREATE TABLE analysis_field_runs (
      id TEXT PRIMARY KEY, record_id TEXT NOT NULL, field_id TEXT NOT NULL,
      status TEXT NOT NULL, result_json TEXT NOT NULL, dependencies_json TEXT NOT NULL,
      evidence_text TEXT,
      prompt_snapshot TEXT NOT NULL, field_snapshot_json TEXT NOT NULL,
      model_config_snapshot_json TEXT NOT NULL, raw_response TEXT, error_message TEXT,
      duration_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, created_at TEXT NOT NULL,
      FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE
    );
    INSERT INTO analysis_field_runs (
      id, record_id, field_id, status, result_json, dependencies_json, evidence_text,
      prompt_snapshot, field_snapshot_json, model_config_snapshot_json, raw_response,
      error_message, duration_ms, input_tokens, output_tokens, created_at
    )
    SELECT
      id, record_id, field_id, status, result_json, dependencies_json, evidence_text,
      prompt_snapshot, field_snapshot_json, model_config_snapshot_json, raw_response,
      error_message, duration_ms, input_tokens, output_tokens, created_at
    FROM analysis_field_runs_before_v18;
    DROP TABLE analysis_field_runs_before_v18;
    CREATE INDEX IF NOT EXISTS idx_field_runs_created_at ON analysis_field_runs(created_at);
    CREATE INDEX IF NOT EXISTS idx_field_runs_record_id ON analysis_field_runs(record_id);
    CREATE INDEX IF NOT EXISTS idx_field_runs_field_created ON analysis_field_runs(field_id, created_at);
  `);
}

function detachOtherExecutionHistoryFromLiveFields(db: any) {
  const referencesFields = (table: string) => (
    db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>
  ).some((foreignKey) => foreignKey.table === "analysis_fields");

  if (referencesFields("knowledge_match_snapshots")) {
    db.exec(`
      ALTER TABLE knowledge_match_snapshots RENAME TO knowledge_match_snapshots_before_v18;
      CREATE TABLE knowledge_match_snapshots (
        id TEXT PRIMARY KEY, record_id TEXT NOT NULL, field_id TEXT NOT NULL,
        knowledge_base_id TEXT NOT NULL, knowledge_item_id TEXT NOT NULL,
        item_values_json TEXT NOT NULL, candidate_snapshot_json TEXT NOT NULL,
        query_snapshot TEXT NOT NULL, model_response TEXT, created_at TEXT NOT NULL,
        FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE
      );
      INSERT INTO knowledge_match_snapshots
      SELECT * FROM knowledge_match_snapshots_before_v18;
      DROP TABLE knowledge_match_snapshots_before_v18;
    `);
  }
  if (referencesFields("hot_topic_record_questions")) {
    db.exec(`
      ALTER TABLE hot_topic_record_questions RENAME TO hot_topic_record_questions_before_v18;
      CREATE TABLE hot_topic_record_questions (
        record_id TEXT NOT NULL, field_id TEXT NOT NULL, knowledge_item_id TEXT NOT NULL,
        question TEXT NOT NULL, evidence TEXT NOT NULL, origin TEXT NOT NULL,
        PRIMARY KEY(record_id, field_id, knowledge_item_id),
        FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE
      );
      INSERT INTO hot_topic_record_questions
      SELECT * FROM hot_topic_record_questions_before_v18;
      DROP TABLE hot_topic_record_questions_before_v18;
      CREATE INDEX IF NOT EXISTS idx_hot_topic_questions_item
        ON hot_topic_record_questions(knowledge_item_id);
    `);
  }
  if (referencesFields("lost_deal_record_reasons")) {
    db.exec(`
      ALTER TABLE lost_deal_record_reasons RENAME TO lost_deal_record_reasons_before_v18;
      CREATE TABLE lost_deal_record_reasons (
        record_id TEXT NOT NULL,
        field_id TEXT NOT NULL,
        knowledge_item_id TEXT NOT NULL,
        reason_type TEXT NOT NULL CHECK(reason_type IN ('customer','service')),
        reason_name TEXT NOT NULL,
        evidence TEXT NOT NULL,
        PRIMARY KEY(record_id, field_id, knowledge_item_id),
        FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE
      );
      INSERT INTO lost_deal_record_reasons
      SELECT * FROM lost_deal_record_reasons_before_v18;
      DROP TABLE lost_deal_record_reasons_before_v18;
      CREATE INDEX IF NOT EXISTS idx_lost_deal_reasons_item
        ON lost_deal_record_reasons(knowledge_item_id);
    `);
  }
}

export function ensureSectionConfigV1(db: any): SectionConfigV1MigrationReport {
  const sections = db.prepare("SELECT * FROM analysis_sections ORDER BY id").all() as any[];
  const insertVersion = db.prepare(`INSERT OR IGNORE INTO analysis_section_versions
    (id, section_id, version_number, status, is_current, section_snapshot_json,
     fields_snapshot_json, export_settings_json, dependencies_snapshot_json,
     knowledge_snapshot_json, business_rules_json, created_at, updated_at, published_at)
    VALUES (?, ?, 1, 'published', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const migratedSections: string[] = [];
  const errors: Array<{ sectionId: string; message: string }> = [];
  let skipped = 0;
  for (const section of sections) {
    try {
      const versionId = `section-version-${section.id}-v1`;
      const snapshot = buildSnapshot(db, section);
      const timestamp = section.updated_at || new Date().toISOString();
      const result = insertVersion.run(
        versionId,
        section.id,
        json(snapshot.sectionSnapshot),
        json(snapshot.fields),
        json(snapshot.exportSettings),
        json(snapshot.dependencies),
        json(snapshot.knowledge),
        json(snapshot.businessRules),
        timestamp,
        timestamp,
        timestamp,
      );
      if (result.changes) migratedSections.push(section.id);
      else skipped++;
    } catch (error) {
      errors.push({ sectionId: section.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  lastSectionConfigV1MigrationReport = {
    succeeded: migratedSections.length,
    skipped,
    errors,
  };
  if (errors.length) {
    throw new Error(`板块配置 V1 迁移失败：${JSON.stringify(errors)}`);
  }
  db.prepare(`
    UPDATE jobs
    SET section_config_version_id = (
      SELECT v.id FROM analysis_section_versions v
      WHERE v.section_id = jobs.section_id AND v.version_number = 1
    )
    WHERE section_config_version_id IS NULL AND section_id IS NOT NULL
  `).run();
  if (migratedSections.length && db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_events'",
  ).get()) {
    const audit = db.prepare(`INSERT INTO audit_events
      (id, organization_id, actor_user_id, actor_display, action, target_type, target_id,
       outcome, metadata_json, correlation_id, occurred_at)
      VALUES (?, 'org-default', NULL, '系统', 'config.version_migration', 'section',
        ?, 'success', ?, NULL, ?)`);
    const timestamp = new Date().toISOString();
    for (const sectionId of migratedSections) {
      audit.run(
        crypto.randomUUID(),
        sectionId,
        JSON.stringify({ sectionId, versionNumber: 1, binding: "legacy-v1" }),
        timestamp,
      );
    }
  }
  return lastSectionConfigV1MigrationReport;
}

export function applySectionConfigVersions(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS analysis_section_versions (
      id TEXT PRIMARY KEY,
      section_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
      is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
      section_snapshot_json TEXT NOT NULL,
      fields_snapshot_json TEXT NOT NULL,
      export_settings_json TEXT NOT NULL,
      dependencies_snapshot_json TEXT NOT NULL,
      knowledge_snapshot_json TEXT NOT NULL,
      business_rules_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT,
      archived_at TEXT,
      UNIQUE(section_id, version_number)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_section_versions_current
      ON analysis_section_versions(section_id)
      WHERE is_current = 1;
    CREATE TRIGGER IF NOT EXISTS section_versions_immutable_content
      BEFORE UPDATE ON analysis_section_versions
      WHEN OLD.status IN ('published', 'archived')
        AND (
          OLD.section_id IS NOT NEW.section_id
          OR OLD.version_number IS NOT NEW.version_number
          OR OLD.section_snapshot_json IS NOT NEW.section_snapshot_json
          OR OLD.fields_snapshot_json IS NOT NEW.fields_snapshot_json
          OR OLD.export_settings_json IS NOT NEW.export_settings_json
          OR OLD.dependencies_snapshot_json IS NOT NEW.dependencies_snapshot_json
          OR OLD.knowledge_snapshot_json IS NOT NEW.knowledge_snapshot_json
          OR OLD.business_rules_json IS NOT NEW.business_rules_json
          OR OLD.created_at IS NOT NEW.created_at
        )
      BEGIN SELECT RAISE(ABORT, '已发布配置版本内容不可修改'); END;
    CREATE TRIGGER IF NOT EXISTS section_versions_no_draft_downgrade
      BEFORE UPDATE OF status ON analysis_section_versions
      WHEN OLD.status IN ('published', 'archived') AND NEW.status = 'draft'
      BEGIN SELECT RAISE(ABORT, '已发布配置版本不能降级为草稿'); END;
    CREATE TRIGGER IF NOT EXISTS section_versions_current_must_be_published_insert
      BEFORE INSERT ON analysis_section_versions
      WHEN NEW.is_current = 1 AND NEW.status != 'published'
      BEGIN SELECT RAISE(ABORT, '当前启用版本必须为已发布状态'); END;
    CREATE TRIGGER IF NOT EXISTS section_versions_current_must_be_published_update
      BEFORE UPDATE OF status, is_current ON analysis_section_versions
      WHEN NEW.is_current = 1 AND NEW.status != 'published'
        AND NOT (OLD.status IN ('published', 'archived') AND NEW.status = 'draft')
      BEGIN SELECT RAISE(ABORT, '当前启用版本必须为已发布状态'); END;
    CREATE TRIGGER IF NOT EXISTS section_versions_immutable_delete
      BEFORE DELETE ON analysis_section_versions
      WHEN OLD.status IN ('published', 'archived')
      BEGIN SELECT RAISE(ABORT, '已发布配置版本不可删除'); END;
    CREATE TRIGGER IF NOT EXISTS section_versions_restrict_section_delete
      BEFORE DELETE ON analysis_sections
      WHEN EXISTS (
        SELECT 1 FROM analysis_section_versions versions
        WHERE versions.section_id = OLD.id
      )
      BEGIN SELECT RAISE(ABORT, '存在配置版本的板块不能删除'); END;
  `);

  detachFieldRunsFromLiveFields(db);
  detachOtherExecutionHistoryFromLiveFields(db);
  const jobColumns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!jobColumns.some((column) => column.name === "section_config_version_id")) {
    db.exec("ALTER TABLE jobs ADD COLUMN section_config_version_id TEXT REFERENCES analysis_section_versions(id)");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_section_config_version ON jobs(section_config_version_id)");
  ensureSectionConfigV1(db);
}
