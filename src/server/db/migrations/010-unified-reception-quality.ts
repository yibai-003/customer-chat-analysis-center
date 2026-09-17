const UNIFIED_KEY = "统一质检分析";
const UNIFIED_ID = "reception-unified-quality";

const FALLBACK_STANDARD = `售前质检：检查重复发送、违反宣传、响应超时、漏跟进、答非所问、知识回复错误、
未正确推荐介绍商品、未及时催拍、反问质疑、未有效安抚、未使用礼貌用语、表达歧义、选择性回复、态度差和跨平台引导。
售后质检：检查漏回复、漏登记、漏备注、漏补发、登记错误、聊天引发投诉、退款或投诉处理错误、
未按要求核实取证、信息泄露、态度问题、敷衍拖延、投诉威胁时放任客户、未按售后 SOP 处理和质问否定客户。
所有违规必须有明确原文或辅助数据证据；缺少必要信息时必须标记无法核验。`;

const DERIVED_FIELDS = [
  ["问题点-售前", 2],
  ["问题点-售后", 3],
  ["有无违规-售后", 4],
  ["客服问题识别问题并打标签", 5],
  ["接待流程质检结果", 6],
  ["优化建议-售前", 7],
] as const;

function currentPrompt(db: any, key: string) {
  return (db.prepare("SELECT prompt FROM analysis_fields WHERE section_id = 'reception' AND key = ?").get(key) as
    | { prompt: string }
    | undefined)?.prompt?.trim() ?? "";
}

function unifiedPrompt(db: any) {
  const existing = currentPrompt(db, UNIFIED_KEY);
  if (existing) return existing;
  const preSale = currentPrompt(db, "问题点-售前");
  const afterSale = currentPrompt(db, "问题点-售后");
  if (!preSale && !afterSale) return FALLBACK_STANDARD;
  return [
    preSale ? `【售前质检标准】\n${preSale}` : "",
    afterSale ? `【售后质检标准】\n${afterSale}` : "",
  ].filter(Boolean).join("\n\n");
}

function ensureUnifiedField(db: any, prompt: string, timestamp: string) {
  const existing = db.prepare(
    "SELECT id FROM analysis_fields WHERE section_id = 'reception' AND key = ?",
  ).get(UNIFIED_KEY) as { id: string } | undefined;
  if (existing) {
    db.prepare(`UPDATE analysis_fields SET
      label = ?, field_type = 'object', prompt = ?, options_json = '[]', output_column = NULL,
      is_required = 1, image_enabled = 0, depends_on_json = '["截图内容总结"]',
      sort_order = 1, execution_type = 'reception_quality_analysis',
      export_enabled = 0, knowledge_base_id = NULL, match_field_key = NULL,
      knowledge_column = NULL, knowledge_sync_enabled = 0, is_enabled = 1, updated_at = ?
      WHERE id = ?`).run(UNIFIED_KEY, prompt, timestamp, existing.id);
    return;
  }
  db.prepare(`INSERT INTO analysis_fields (
    id, section_id, key, label, field_type, prompt, options_json, output_column,
    is_required, image_enabled, depends_on_json, sort_order, execution_type,
    export_enabled, candidate_limit, knowledge_sync_enabled, knowledge_capture_limit,
    is_enabled, created_at, updated_at
  ) VALUES (?, 'reception', ?, ?, 'object', ?, '[]', NULL, 1, 0,
    '["截图内容总结"]', 1, 'reception_quality_analysis', 0, 15, 0, 2, 1, ?, ?)`).run(
    UNIFIED_ID,
    UNIFIED_KEY,
    UNIFIED_KEY,
    prompt,
    timestamp,
    timestamp,
  );
}

function ensureDerivedField(db: any, key: string, sortOrder: number, timestamp: string) {
  const prompt = "由统一质检分析结果通过本地规则自动生成，不单独调用 AI。";
  const existing = db.prepare(
    "SELECT id FROM analysis_fields WHERE section_id = 'reception' AND key = ?",
  ).get(key) as { id: string } | undefined;
  if (existing) {
    db.prepare(`UPDATE analysis_fields SET
      label = ?, field_type = 'string', prompt = ?, options_json = '[]', output_column = ?, is_required = 0,
      image_enabled = 0, depends_on_json = '["统一质检分析"]', sort_order = ?,
      execution_type = 'reception_quality_derive', export_enabled = 1,
      knowledge_base_id = NULL, match_field_key = NULL, knowledge_column = NULL,
      knowledge_sync_enabled = 0, is_enabled = 1, updated_at = ?
      WHERE id = ?`).run(key, prompt, key, sortOrder, timestamp, existing.id);
    return;
  }
  db.prepare(`INSERT INTO analysis_fields (
    id, section_id, key, label, field_type, prompt, options_json, output_column,
    is_required, image_enabled, depends_on_json, sort_order, execution_type,
    export_enabled, candidate_limit, knowledge_sync_enabled, knowledge_capture_limit,
    is_enabled, created_at, updated_at
  ) VALUES (?, 'reception', ?, ?, 'string', ?, '[]', ?, 0, 0,
    '["统一质检分析"]', ?, 'reception_quality_derive', 1, 15, 0, 2, 1, ?, ?)`).run(
    `reception-derived-${sortOrder}`,
    key,
    key,
    prompt,
    key,
    sortOrder,
    timestamp,
    timestamp,
  );
}

export function applyUnifiedReceptionQualityConfiguration(db: any) {
  const section = db.prepare("SELECT id FROM analysis_sections WHERE id = 'reception'").get();
  if (!section) return;
  const timestamp = new Date().toISOString();
  ensureUnifiedField(db, unifiedPrompt(db), timestamp);
  for (const [key, sortOrder] of DERIVED_FIELDS) ensureDerivedField(db, key, sortOrder, timestamp);
  db.prepare(`UPDATE analysis_fields
    SET is_enabled = 0, export_enabled = 0, updated_at = ?
    WHERE section_id = 'reception'
      AND key IN ('conclusion', 'issueType', 'suggestion', 'confidence')`).run(timestamp);
}

export function applyUnifiedReceptionQuality(db: any) {
  applyUnifiedReceptionQualityConfiguration(db);
}
