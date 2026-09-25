import crypto from "node:crypto";

export function applyReceptionIssueRowExport(db: any) {
  const current = db.prepare(`
    SELECT *
    FROM analysis_section_versions
    WHERE section_id = 'reception' AND is_current = 1
  `).get() as any;
  if (!current) return;

  const settings = JSON.parse(current.export_settings_json) as {
    rowMode?: string;
    outputColumns?: unknown[];
  };
  if (settings.rowMode === "reception_issue_records") return;

  const nextNumber = (db.prepare(`
    SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number
    FROM analysis_section_versions
    WHERE section_id = 'reception'
  `).get() as { next_number: number }).next_number;
  const timestamp = new Date().toISOString();
  const id = `section-version-reception-v${nextNumber}-${crypto.randomUUID()}`;
  const exportSettings = JSON.stringify({
    ...settings,
    rowMode: "reception_issue_records",
  });

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
    exportSettings,
    current.dependencies_snapshot_json,
    current.knowledge_snapshot_json,
    current.business_rules_json,
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
        upgrade: "reception-issue-row-export",
      }),
      timestamp,
    );
  }
}
