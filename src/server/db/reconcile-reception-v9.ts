import crypto from "node:crypto";

const RECONCILED_VERSIONS = [
  { versionNumber: 8, rowMode: "reception_issue_records", status: "archived", isCurrent: 0 },
  { versionNumber: 9, rowMode: "screenshot_records", status: "published", isCurrent: 1 },
] as const;

export function reconcileReceptionV9(db: any) {
  db.transaction(() => {
    const current = db.prepare(`
      SELECT *
      FROM analysis_section_versions
      WHERE section_id = 'reception' AND is_current = 1
    `).get() as any;
    if (!current) return;

    const latest = db.prepare(`
      SELECT MAX(version_number) AS version_number
      FROM analysis_section_versions
      WHERE section_id = 'reception'
    `).get() as { version_number: number | null };
    if (current.version_number !== 7 || latest.version_number !== 7) return;

    let previousVersionId = current.id as string;
    for (const target of RECONCILED_VERSIONS) {
      const timestamp = new Date().toISOString();
      const versionId = `section-version-reception-v${target.versionNumber}-${crypto.randomUUID()}`;
      const exportSettings = {
        ...JSON.parse(current.export_settings_json),
        rowMode: target.rowMode,
      };

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
        ) VALUES (?, 'reception', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        versionId,
        target.versionNumber,
        target.status,
        target.isCurrent,
        current.section_snapshot_json,
        current.fields_snapshot_json,
        JSON.stringify(exportSettings),
        current.dependencies_snapshot_json,
        current.knowledge_snapshot_json,
        current.business_rules_json,
        timestamp,
        timestamp,
        timestamp,
        target.status === "archived" ? timestamp : null,
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
            fromVersionId: previousVersionId,
            versionNumber: target.versionNumber,
            upgrade: "reconcile-reception-v9",
          }),
          timestamp,
        );
      }
      previousVersionId = versionId;
    }
  })();
}
