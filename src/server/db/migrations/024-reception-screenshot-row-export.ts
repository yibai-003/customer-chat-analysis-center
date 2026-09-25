import crypto from "node:crypto";

const RECEPTION_EXPORT_SETTINGS = {
  rowMode: "screenshot_records",
  outputColumns: [
    { key: "platform_name", outputColumn: "平台", source: "platform_name", format: "value" },
    { key: "conversation_id", outputColumn: "会话ID", source: "conversation_id", format: "value" },
    { key: "quality_issue_names", outputColumn: "问题", source: "reception_quality", format: "reception_issue_names_csv" },
    { key: "quality_issue_dimensions", outputColumn: "维度", source: "reception_quality", format: "reception_issue_dimensions_csv" },
    { key: "quality_issue_deductions", outputColumn: "扣分", source: "reception_quality", format: "reception_issue_deductions_csv" },
    { key: "quality_total_deduction", outputColumn: "合计扣分", source: "reception_quality", format: "reception_total_deduction" },
    { key: "quality_has_d_level", outputColumn: "是否D级", source: "reception_quality", format: "reception_has_d_level" },
    { key: "quality_chat_quotes", outputColumn: "聊天原文", source: "reception_quality", format: "reception_chat_quotes" },
    { key: "quality_evidence", outputColumn: "证据说明", source: "reception_quality", format: "reception_evidence_explanations" },
    { key: "quality_reasons", outputColumn: "判定理由", source: "reception_quality", format: "reception_reasons" },
    { key: "quality_suggestions", outputColumn: "优化建议", source: "reception_quality", format: "reception_suggestions" },
    { key: "quality_grade", outputColumn: "接待流程质检结果", source: "reception_quality", format: "reception_grade" },
    { key: "quality_review_required", outputColumn: "是否待人工复核", source: "reception_quality", format: "reception_review_required" },
    { key: "quality_start_time", outputColumn: "会话开始时间", source: "reception_quality", format: "reception_start_time" },
    { key: "quality_round_count", outputColumn: "对话轮数", source: "reception_quality", format: "reception_round_count" },
  ],
};

function hasScreenshotRowExport(raw: string) {
  try {
    const settings = JSON.parse(raw) as typeof RECEPTION_EXPORT_SETTINGS;
    const formats = new Set(settings.outputColumns?.map((column) => `${column.source}:${column.format}`));
    return settings.rowMode === "screenshot_records"
      && formats.has("platform_name:value")
      && formats.has("conversation_id:value")
      && formats.has("reception_quality:reception_issue_names_csv")
      && formats.has("reception_quality:reception_issue_dimensions_csv")
      && formats.has("reception_quality:reception_issue_deductions_csv")
      && formats.has("reception_quality:reception_total_deduction")
      && formats.has("reception_quality:reception_has_d_level")
      && formats.has("reception_quality:reception_chat_quotes")
      && formats.has("reception_quality:reception_evidence_explanations")
      && formats.has("reception_quality:reception_reasons")
      && formats.has("reception_quality:reception_suggestions")
      && formats.has("reception_quality:reception_grade")
      && formats.has("reception_quality:reception_review_required")
      && formats.has("reception_quality:reception_start_time")
      && formats.has("reception_quality:reception_round_count");
  } catch {
    return false;
  }
}

export function applyReceptionScreenshotRowExport(db: any) {
  const current = db.prepare(`
    SELECT *
    FROM analysis_section_versions
    WHERE section_id = 'reception' AND is_current = 1
  `).get() as any;
  if (!current || hasScreenshotRowExport(current.export_settings_json)) return;

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
    JSON.stringify(RECEPTION_EXPORT_SETTINGS),
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
        upgrade: "reception-screenshot-row-export",
      }),
      timestamp,
    );
  }
}
