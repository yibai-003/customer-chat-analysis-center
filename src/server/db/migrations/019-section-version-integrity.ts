import crypto from "node:crypto";
import { sectionBusinessRules } from "../../services/section-business-rules";

function createVersionGuards(db: any) {
  db.exec(`
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
}

function rebuildVersionTableWithSectionForeignKey(db: any) {
  const sectionForeignKey = (
    db.prepare("PRAGMA foreign_key_list(analysis_section_versions)").all() as Array<{
      table: string;
      from: string;
      on_delete: string;
    }>
  ).some((foreignKey) => (
    foreignKey.table === "analysis_sections"
    && foreignKey.from === "section_id"
    && foreignKey.on_delete.toUpperCase() === "RESTRICT"
  ));
  if (sectionForeignKey) return;

  db.exec(`
    DROP TRIGGER IF EXISTS section_versions_immutable_content;
    DROP TRIGGER IF EXISTS section_versions_no_draft_downgrade;
    DROP TRIGGER IF EXISTS section_versions_current_must_be_published_insert;
    DROP TRIGGER IF EXISTS section_versions_current_must_be_published_update;
    DROP TRIGGER IF EXISTS section_versions_immutable_delete;
    DROP TRIGGER IF EXISTS section_versions_restrict_section_delete;
    DROP INDEX IF EXISTS idx_section_versions_current;
    CREATE TABLE analysis_section_versions_v19 (
      id TEXT PRIMARY KEY,
      section_id TEXT NOT NULL REFERENCES analysis_sections(id) ON DELETE RESTRICT,
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
    INSERT INTO analysis_section_versions_v19
    SELECT * FROM analysis_section_versions;
    DROP TABLE analysis_section_versions;
    ALTER TABLE analysis_section_versions_v19 RENAME TO analysis_section_versions;
  `);
  createVersionGuards(db);
}

function hasCompleteReceptionDimensions(raw: string): boolean {
  try {
    const rules = JSON.parse(raw) as { issues?: Array<{ dimension?: unknown }> };
    return Array.isArray(rules.issues)
      && rules.issues.length > 0
      && rules.issues.every((issue) => typeof issue.dimension === "string" && issue.dimension.trim().length > 0);
  } catch {
    return false;
  }
}

function publishDimensionedReceptionVersion(db: any) {
  const current = db.prepare(`
    SELECT *
    FROM analysis_section_versions
    WHERE section_id = 'reception' AND is_current = 1
  `).get() as any;
  if (!current || hasCompleteReceptionDimensions(current.business_rules_json)) return;

  const legacyRules = JSON.parse(current.business_rules_json) as {
    [key: string]: unknown;
    issues?: Array<Record<string, unknown>>;
  };
  const canonicalRules = sectionBusinessRules("reception") as {
    issues: Array<{ id: string; dimension: string }>;
  };
  const canonicalDimensions = new Map(canonicalRules.issues.map((issue) => [issue.id, issue.dimension]));
  const businessRules = {
    ...legacyRules,
    issues: (legacyRules.issues ?? []).map((issue) => ({
      ...issue,
      dimension: typeof issue.dimension === "string" && issue.dimension.trim()
        ? issue.dimension
        : canonicalDimensions.get(String(issue.id)) ?? "",
    })),
  };
  if (!hasCompleteReceptionDimensions(JSON.stringify(businessRules))) {
    throw new Error("接待质检 V1 缺少可恢复的问题维度");
  }

  const nextNumber = (db.prepare(`
    SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number
    FROM analysis_section_versions
    WHERE section_id = 'reception'
  `).get() as { next_number: number }).next_number;
  const timestamp = new Date().toISOString();
  const id = `section-version-reception-v${nextNumber}-${crypto.randomUUID()}`;
  db.prepare(`
    UPDATE analysis_section_versions
    SET is_current = 0, updated_at = ?
    WHERE section_id = 'reception' AND is_current = 1
  `).run(timestamp);
  db.prepare(`
    INSERT INTO analysis_section_versions (
      id, section_id, version_number, status, is_current,
      section_snapshot_json, fields_snapshot_json, export_settings_json,
      dependencies_snapshot_json, knowledge_snapshot_json, business_rules_json,
      created_at, updated_at, published_at, archived_at
    ) VALUES (?, 'reception', ?, 'published', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    id,
    nextNumber,
    current.section_snapshot_json,
    current.fields_snapshot_json,
    current.export_settings_json,
    current.dependencies_snapshot_json,
    current.knowledge_snapshot_json,
    JSON.stringify(businessRules),
    timestamp,
    timestamp,
    timestamp,
  );

  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_events'").get()) {
    db.prepare(`
      INSERT INTO audit_events (
        id, organization_id, actor_user_id, actor_display, action, target_type,
        target_id, outcome, metadata_json, correlation_id, occurred_at
      ) VALUES (?, 'org-default', NULL, '系统', 'config.version_migration',
        'section', 'reception', 'success', ?, NULL, ?)
    `).run(
      crypto.randomUUID(),
      JSON.stringify({
        sectionId: "reception",
        fromVersionId: current.id,
        versionNumber: nextNumber,
        upgrade: "reception-rule-dimensions",
      }),
      timestamp,
    );
  }
}

export function applySectionVersionIntegrity(db: any) {
  rebuildVersionTableWithSectionForeignKey(db);
  publishDimensionedReceptionVersion(db);
}
