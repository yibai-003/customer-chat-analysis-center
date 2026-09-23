import crypto from "node:crypto";

const DERIVED_PROMPT = "由统一质检分析结果通过本地规则自动生成，不单独调用 AI。";

const MODERN_DERIVED_FIELDS = [
  { key: "会话开始时间", outputColumn: "会话开始时间 (conversation_started_at)", type: "string" },
  { key: "会话ID", outputColumn: "会话ID (conversation_id)", type: "string" },
  { key: "对话轮数", outputColumn: "对话轮数 (turn_count)", type: "number" },
  { key: "等级", outputColumn: "等级 (rating)", type: "string" },
  { key: "合计扣分", outputColumn: "合计扣分 (total_deduction)", type: "number" },
  { key: "优化建议", outputColumn: "优化建议 (improvement_advice)", type: "string" },
  { key: "是否待人工复核", outputColumn: "是否待人工复核 (needs_manual_review)", type: "string" },
  { key: "维度", outputColumn: "维度 (dimension)", type: "string" },
  { key: "问题", outputColumn: "问题 (issue)", type: "string" },
  { key: "扣分", outputColumn: "扣分 (deduction)", type: "string" },
  { key: "是否D级", outputColumn: "是否D级 (d_level)", type: "string" },
  { key: "聊天原文", outputColumn: "聊天原文 (chat_excerpt)", type: "string" },
  { key: "证据说明", outputColumn: "证据说明 (evidence)", type: "string" },
  { key: "判定理由", outputColumn: "判定理由 (judgement_reason)", type: "string" },
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

function upsertDerivedField(
  db: any,
  field: (typeof MODERN_DERIVED_FIELDS)[number],
  sortOrder: number,
  timestamp: string,
) {
  const existing = db.prepare(
    "SELECT id FROM analysis_fields WHERE section_id = 'reception' AND key = ?",
  ).get(field.key) as { id: string } | undefined;
  if (existing) {
    db.prepare(`
      UPDATE analysis_fields
      SET label = ?, field_type = ?, prompt = ?, options_json = '[]',
          output_column = ?, is_required = 0, image_enabled = 0,
          depends_on_json = '["统一质检分析"]', sort_order = ?,
          execution_type = 'reception_quality_derive', export_enabled = 1,
          knowledge_base_id = NULL, match_field_key = NULL, knowledge_column = NULL,
          knowledge_sync_enabled = 0, is_enabled = 1, updated_at = ?
      WHERE id = ?
    `).run(
      field.key,
      field.type,
      DERIVED_PROMPT,
      field.outputColumn,
      sortOrder,
      timestamp,
      existing.id,
    );
    return existing.id;
  }
  const id = `reception-v5-derived-${sortOrder}-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO analysis_fields (
      id, section_id, key, label, field_type, prompt, options_json, output_column,
      is_required, image_enabled, depends_on_json, sort_order, execution_type,
      export_enabled, candidate_limit, knowledge_sync_enabled, knowledge_capture_limit,
      is_enabled, created_at, updated_at
    ) VALUES (?, 'reception', ?, ?, ?, ?, '[]', ?, 0, 0,
      '["统一质检分析"]', ?, 'reception_quality_derive', 1, 15, 0, 2, 1, ?, ?)
  `).run(
    id,
    field.key,
    field.key,
    field.type,
    DERIVED_PROMPT,
    field.outputColumn,
    sortOrder,
    timestamp,
    timestamp,
  );
  return id;
}

export function applyReceptionV5DerivedResults(db: any) {
  const current = db.prepare(`
    SELECT *
    FROM analysis_section_versions
    WHERE section_id = 'reception' AND is_current = 1
  `).get() as any;
  if (!current) return;
  const existingFields = parseJson(current.fields_snapshot_json, []) as any[];
  const facts = existingFields.find((field) => field.key === "截图内容总结");
  const quality = existingFields.find((field) => field.key === "统一质检分析");
  if (!facts || !quality) throw new Error("接待质检缺少两阶段核心字段，无法创建派生结果版本");

  const timestamp = new Date().toISOString();
  const enabledKeys = ["截图内容总结", "统一质检分析", ...MODERN_DERIVED_FIELDS.map((field) => field.key)];
  const liveIds = MODERN_DERIVED_FIELDS.map((field, index) =>
    upsertDerivedField(db, field, index + 2, timestamp));
  const placeholders = enabledKeys.map(() => "?").join(",");
  db.prepare(`
    UPDATE analysis_fields
    SET is_enabled = 0, export_enabled = 0, updated_at = ?
    WHERE section_id = 'reception' AND key NOT IN (${placeholders})
  `).run(timestamp, ...enabledKeys);

  const fieldsSnapshot = [
    { ...facts, sortOrder: 0, isEnabled: true, exportEnabled: false },
    { ...quality, sortOrder: 1, isEnabled: true, exportEnabled: false },
    ...MODERN_DERIVED_FIELDS.map((field, index) => ({
      id: liveIds[index],
      sectionId: "reception",
      key: field.key,
      label: field.key,
      type: field.type,
      prompt: DERIVED_PROMPT,
      options: [],
      outputColumn: field.outputColumn,
      required: false,
      imageEnabled: false,
      dependsOn: ["统一质检分析"],
      sortOrder: index + 2,
      isEnabled: true,
      executionType: "reception_quality_derive",
      exportEnabled: true,
      candidateLimit: 15,
      knowledgeSyncEnabled: false,
      knowledgeCaptureLimit: 2,
    })),
  ];
  const dependenciesSnapshot = fieldsSnapshot.map((field) => ({
    key: field.key,
    dependsOn: field.dependsOn,
  }));
  const nextNumber = (db.prepare(`
    SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number
    FROM analysis_section_versions
    WHERE section_id = 'reception'
  `).get() as { next_number: number }).next_number;
  const versionId = `section-version-reception-v${nextNumber}-${crypto.randomUUID()}`;

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
    current.section_snapshot_json,
    JSON.stringify(fieldsSnapshot),
    current.export_settings_json,
    JSON.stringify(dependenciesSnapshot),
    current.knowledge_snapshot_json,
    current.business_rules_json,
    timestamp,
    timestamp,
    timestamp,
  );
  audit(db, {
    sectionId: "reception",
    fromVersionId: current.id,
    versionNumber: nextNumber,
    upgrade: "reception-v5-derived-results",
  }, timestamp);
}
