import crypto from "node:crypto";
import {
  RECEPTION_V4_QUALITY_PROMPT,
  RECEPTION_V4_RESULT_FIELDS,
  RECEPTION_V4_SCREENSHOT_FACTS_PROMPT,
  RECEPTION_V4_SOURCE_FIELDS,
} from "../../services/reception-quality-v4-prompts";

const MODERN_EXPORT_COLUMNS = [
  { key: "platform_name", outputColumn: "平台 (platform_name)", source: "platform_name", format: "value" },
  { key: "conversation_id", outputColumn: "会话ID (conversation_id)", source: "conversation_id", format: "value" },
  { key: "quality_issue_names", outputColumn: "问题 (issue)", source: "reception_quality", format: "reception_issue_names_csv" },
  { key: "quality_issue_dimensions", outputColumn: "维度 (dimension)", source: "reception_quality", format: "reception_issue_dimensions_csv" },
  { key: "quality_issue_deductions", outputColumn: "扣分 (deduction)", source: "reception_quality", format: "reception_issue_deductions_csv" },
  { key: "quality_total_deduction", outputColumn: "合计扣分 (total_deduction)", source: "reception_quality", format: "reception_total_deduction" },
  { key: "quality_has_d_level", outputColumn: "是否D级 (d_level)", source: "reception_quality", format: "reception_has_d_level" },
  { key: "quality_chat_quotes", outputColumn: "聊天原文 (chat_excerpt)", source: "reception_quality", format: "reception_chat_quotes" },
  { key: "quality_evidence", outputColumn: "证据说明 (evidence)", source: "reception_quality", format: "reception_evidence_explanations" },
  { key: "quality_reasons", outputColumn: "判定理由 (judgement_reason)", source: "reception_quality", format: "reception_reasons" },
  { key: "quality_suggestions", outputColumn: "优化建议 (improvement_advice)", source: "reception_quality", format: "reception_suggestions" },
  { key: "quality_grade", outputColumn: "等级 (rating)", source: "reception_quality", format: "reception_grade" },
  { key: "quality_review_required", outputColumn: "是否待人工复核 (needs_manual_review)", source: "reception_quality", format: "reception_review_required" },
  { key: "quality_start_time", outputColumn: "会话开始时间 (conversation_started_at)", source: "reception_quality", format: "reception_start_time" },
  { key: "quality_round_count", outputColumn: "对话轮数 (turn_count)", source: "reception_quality", format: "reception_round_count" },
] as const;

function parseJson(value: string | null | undefined, fallback: unknown) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function audit(db: any, metadata: Record<string, unknown>, timestamp: string) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_events'").get()) return;
  db.prepare(`
    INSERT INTO audit_events (
      id, organization_id, actor_user_id, actor_display, action, target_type,
      target_id, outcome, metadata_json, correlation_id, occurred_at
    ) VALUES (?, 'org-default', NULL, '系统', 'config.version_migration',
      'section', 'reception', 'success', ?, NULL, ?)
  `).run(crypto.randomUUID(), JSON.stringify(metadata), timestamp);
}

export function applyReceptionV4ModernTemplate(db: any) {
  const section = db.prepare("SELECT * FROM analysis_sections WHERE id = 'reception'").get() as any;
  const current = db.prepare(`
    SELECT *
    FROM analysis_section_versions
    WHERE section_id = 'reception' AND is_current = 1
  `).get() as any;
  if (!section || !current) return;

  const existingFields = (parseJson(current.fields_snapshot_json, []) as any[]);
  const facts = existingFields.find((field) => field.key === "截图内容总结");
  const quality = existingFields.find((field) => field.key === "统一质检分析");
  if (!facts || !quality) throw new Error("接待质检缺少两阶段核心字段，无法创建 V4");

  const timestamp = new Date().toISOString();
  const nextNumber = (db.prepare(`
    SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number
    FROM analysis_section_versions
    WHERE section_id = 'reception'
  `).get() as { next_number: number }).next_number;
  const versionId = `section-version-reception-v${nextNumber}-${crypto.randomUUID()}`;
  const sectionSnapshot = {
    ...parseJson(current.section_snapshot_json, {}),
    sourceFields: [...RECEPTION_V4_SOURCE_FIELDS],
  };
  const fieldsSnapshot = [
    {
      ...facts,
      label: "截图内容总结",
      type: "object",
      prompt: RECEPTION_V4_SCREENSHOT_FACTS_PROMPT,
      outputColumn: null,
      required: true,
      imageEnabled: true,
      dependsOn: [],
      executionType: "reception_screenshot_facts",
      exportEnabled: false,
      isEnabled: true,
      sortOrder: 0,
    },
    {
      ...quality,
      label: "统一质检分析",
      type: "object",
      prompt: RECEPTION_V4_QUALITY_PROMPT,
      outputColumn: null,
      required: true,
      imageEnabled: false,
      dependsOn: ["截图内容总结"],
      executionType: "reception_quality_analysis",
      exportEnabled: false,
      isEnabled: true,
      sortOrder: 1,
    },
  ];
  const dependenciesSnapshot = fieldsSnapshot.map((field) => ({
    key: field.key,
    dependsOn: field.dependsOn,
  }));
  const previousRules = parseJson(current.business_rules_json, {}) as Record<string, any>;
  const businessRules = {
    ...previousRules,
    importContract: {
      imageColumn: "聊天截图 (chat_screenshot)",
      resultColumns: [...RECEPTION_V4_RESULT_FIELDS],
      completeHistoricalResultRequiredColumns: [
        "会话ID (conversation_id)",
        "对话轮数 (turn_count)",
        "等级 (rating)",
        "合计扣分 (total_deduction)",
        "是否待人工复核 (needs_manual_review)",
      ],
    },
  };

  db.prepare(`
    UPDATE analysis_sections
    SET source_fields_json = ?, updated_at = ?
    WHERE id = 'reception'
  `).run(JSON.stringify(RECEPTION_V4_SOURCE_FIELDS), timestamp);
  db.prepare(`
    UPDATE analysis_fields
    SET prompt = ?, output_column = NULL, image_enabled = 1, depends_on_json = '[]',
        execution_type = 'reception_screenshot_facts', is_required = 1,
        export_enabled = 0, is_enabled = 1, sort_order = 0, updated_at = ?
    WHERE section_id = 'reception' AND key = '截图内容总结'
  `).run(RECEPTION_V4_SCREENSHOT_FACTS_PROMPT, timestamp);
  db.prepare(`
    UPDATE analysis_fields
    SET prompt = ?, output_column = NULL, image_enabled = 0, depends_on_json = '["截图内容总结"]',
        execution_type = 'reception_quality_analysis', is_required = 1,
        export_enabled = 0, is_enabled = 1, sort_order = 1, updated_at = ?
    WHERE section_id = 'reception' AND key = '统一质检分析'
  `).run(RECEPTION_V4_QUALITY_PROMPT, timestamp);
  db.prepare(`
    UPDATE analysis_fields
    SET is_enabled = 0, export_enabled = 0, updated_at = ?
    WHERE section_id = 'reception'
      AND key NOT IN ('截图内容总结', '统一质检分析')
  `).run(timestamp);

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
    versionId,
    nextNumber,
    JSON.stringify(sectionSnapshot),
    JSON.stringify(fieldsSnapshot),
    JSON.stringify({ rowMode: "screenshot_records", outputColumns: MODERN_EXPORT_COLUMNS }),
    JSON.stringify(dependenciesSnapshot),
    current.knowledge_snapshot_json,
    JSON.stringify(businessRules),
    timestamp,
    timestamp,
    timestamp,
  );
  audit(db, {
    sectionId: "reception",
    fromVersionId: current.id,
    versionNumber: nextNumber,
    upgrade: "reception-v4-modern-template",
  }, timestamp);
}
