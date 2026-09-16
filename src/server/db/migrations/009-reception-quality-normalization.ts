const SCREENSHOT_FACTS_KEY = "截图内容总结";
const SCREENSHOT_FACTS_ID = "reception-screenshot-facts";

const RECEPTION_SOURCE_FIELDS = [
  "平台",
  "店铺",
  "日期",
  "客服",
  "客户ID",
  "分组",
  "商品编码",
  "商品名称",
  "聊天截图",
  "订单号",
  "颜色款式",
  "品类",
  "问题点-售前",
  "接待流程质检结果",
  "优化建议-售前",
  "组长复检文本",
  "创建时间",
];

const SCREENSHOT_FACTS_PROMPT = `只进行一次截图事实抽取，不做售前或售后质检，不判定客服是否违规。

请严格依据聊天截图和辅助字段，输出结构化事实：
1. 会话场景：售前、售后或无法判断
2. 聊天内容总结：按时间顺序概括买家问题、客服回复和会话结果
3. 客户核心诉求：只写买家明确表达的首要诉求
4. 客服关键行为：只记录原文中明确出现的回复、推荐、解释、安抚、催拍、转交或收尾
5. 关键业务事实：商品、规格、数量、订单、活动、物流、时间等原文明确信息
6. 证据片段：保留能支持后续质检的最小必要原文，标明买家或客服
7. 缺失信息：列出无法从截图或辅助字段确认的内容

禁止虚构、补全或评价。不要输出问题标签、扣分、等级、整改建议或任何质检结论。`;

function fieldRow(db: any, sectionId: string, key: string) {
  return db.prepare("SELECT * FROM analysis_fields WHERE section_id = ? AND key = ?").get(sectionId, key) as any;
}

function ensureScreenshotFactsField(db: any, timestamp: string) {
  const existing = fieldRow(db, "reception", SCREENSHOT_FACTS_KEY);
  if (existing) {
    db.prepare(`UPDATE analysis_fields SET
      label = ?, field_type = 'object', prompt = ?, options_json = '[]',
      output_column = ?, is_required = 1, image_enabled = 1, depends_on_json = '[]',
      sort_order = 0, execution_type = 'ai', export_enabled = 0, is_enabled = 1,
      updated_at = ?
      WHERE id = ?`).run(
      SCREENSHOT_FACTS_KEY,
      SCREENSHOT_FACTS_PROMPT,
      SCREENSHOT_FACTS_KEY,
      timestamp,
      existing.id,
    );
    return;
  }

  db.prepare(`INSERT INTO analysis_fields (
    id, section_id, key, label, field_type, prompt, options_json, output_column,
    is_required, image_enabled, depends_on_json, sort_order, execution_type,
    export_enabled, candidate_limit, knowledge_sync_enabled, knowledge_capture_limit,
    is_enabled, created_at, updated_at
  ) VALUES (?, 'reception', ?, ?, 'object', ?, '[]', ?, 1, 1, '[]', 0, 'ai', 0, 15, 0, 2, 1, ?, ?)`).run(
    SCREENSHOT_FACTS_ID,
    SCREENSHOT_FACTS_KEY,
    SCREENSHOT_FACTS_KEY,
    SCREENSHOT_FACTS_PROMPT,
    SCREENSHOT_FACTS_KEY,
    timestamp,
    timestamp,
  );
}

function updateField(db: any, key: string, values: {
  imageEnabled?: number;
  dependsOn?: string[];
  isEnabled?: number;
  sortOrder?: number;
  required?: number;
}) {
  const updates: string[] = [];
  const params: unknown[] = [];
  if (values.imageEnabled !== undefined) {
    updates.push("image_enabled = ?");
    params.push(values.imageEnabled);
  }
  if (values.dependsOn !== undefined) {
    updates.push("depends_on_json = ?");
    params.push(JSON.stringify(values.dependsOn));
  }
  if (values.isEnabled !== undefined) {
    updates.push("is_enabled = ?");
    params.push(values.isEnabled);
  }
  if (values.sortOrder !== undefined) {
    updates.push("sort_order = ?");
    params.push(values.sortOrder);
  }
  if (values.required !== undefined) {
    updates.push("is_required = ?");
    params.push(values.required);
  }
  if (!updates.length) return;
  params.push("reception", key);
  db.prepare(`UPDATE analysis_fields SET ${updates.join(", ")}, updated_at = ?
    WHERE section_id = ? AND key = ?`).run(...params.slice(0, -2), new Date().toISOString(), ...params.slice(-2));
}

export function applyReceptionQualityConfiguration(db: any) {
  const section = db.prepare("SELECT id FROM analysis_sections WHERE id = 'reception'").get();
  if (!section) return;

  const timestamp = new Date().toISOString();
  db.prepare("UPDATE analysis_sections SET source_fields_json = ?, updated_at = ? WHERE id = 'reception'")
    .run(JSON.stringify(RECEPTION_SOURCE_FIELDS), timestamp);

  ensureScreenshotFactsField(db, timestamp);

  updateField(db, "问题点-售前", {
    imageEnabled: 0,
    dependsOn: [SCREENSHOT_FACTS_KEY],
    isEnabled: 1,
    sortOrder: 1,
    required: 1,
  });
  updateField(db, "客服问题识别问题并打标签", {
    imageEnabled: 0,
    dependsOn: ["问题点-售前"],
    isEnabled: 1,
    sortOrder: 2,
  });
  updateField(db, "接待流程质检结果", {
    imageEnabled: 0,
    dependsOn: ["问题点-售前"],
    isEnabled: 1,
    sortOrder: 3,
  });
  updateField(db, "优化建议-售前", {
    imageEnabled: 0,
    dependsOn: ["问题点-售前"],
    isEnabled: 1,
    sortOrder: 4,
  });

  // These fields belong to after-sales review and must not run in the reception section.
  updateField(db, "问题点-售后", { imageEnabled: 0, dependsOn: [], isEnabled: 0, sortOrder: 90 });
  updateField(db, "有无违规-售后", { imageEnabled: 0, dependsOn: [], isEnabled: 0, sortOrder: 91 });
}

export function applyReceptionQualityNormalization(db: any) {
  applyReceptionQualityConfiguration(db);
}
