import crypto from "node:crypto";

const CUSTOMER_BASE_ID = "lost-deal-customer-reasons";
const SERVICE_BASE_ID = "lost-deal-service-reasons";

const customerReasons = [
  ["价格超出预算", "客户明确表示价格过高、预算不足或期望更低价格", "客户直接提及贵、预算或目标价格", "仅询问价格但未表达价格顾虑"],
  ["产品功能不符合需求", "现有产品功能无法满足客户明确使用需求", "客户明确提出缺少某项功能", "客户只是询问功能但未表示无法满足"],
  ["规格或尺寸不合适", "产品规格、尺寸或容量与客户场景不匹配", "客户明确说明过大、过小或无法放置", "客户只是询问尺寸"],
  ["款式或颜色不符合需求", "现有款式、颜色或外观没有满足客户偏好", "客户明确询问但没有所需款式或颜色", "客户未明确提出款式或颜色要求"],
  ["对品质或效果有顾虑", "客户对产品品质、效果、安全或耐用性存在明确顾虑", "客户直接表达担心或质疑", "客服已明确回应且客户没有继续表达顾虑"],
  ["物流时效不满足", "发货或送达时间无法满足客户明确时限", "客户提出具体到货时间且无法满足", "没有明确时限要求"],
  ["暂时没有购买计划", "客户明确表示暂不购买、再考虑或以后再买", "客户明确表达推迟购买", "仅短暂未回复"],
  ["正在比较其他商品", "客户明确表示仍在对比其他品牌、店铺或方案", "客户提及比较后再决定", "客户没有明确提到比较"],
] as const;

const serviceReasons = [
  ["未确认客户需求", "客服没有充分确认使用场景、预算、规格或限制条件", "对客户核心条件缺少必要追问", "客服已完成关键需求确认"],
  ["回复不及时", "客服响应明显滞后并影响客户继续沟通", "对话中有明确等待、催促或长时间中断", "对话中没有可识别的等待或延迟"],
  ["未处理客户顾虑", "客户提出关键疑问或顾虑后，客服没有直接回应", "关键问题被忽略、回避或答非所问", "客服已明确回答该顾虑"],
  ["产品推荐不准确", "推荐结果与客户已经表达的需求或限制不匹配", "推荐的功能、规格或场景明显不适配", "客户没有明确表达需求或限制"],
  ["优惠说明不清晰", "价格、活动、优惠条件或到手价说明不明确", "客户询问优惠后仍无法确认价格", "客服已清楚说明最终价格和条件"],
  ["未提供成交引导", "完成答疑后没有给出明确下一步或促成下单动作", "没有推荐链接、下单指引或确认意向", "客户仍在持续提问且对话尚未结束"],
  ["保障说明不足", "没有充分说明售后、退换、质保或风险保障", "客户的保障顾虑未获得具体承诺", "客户没有提出保障相关顾虑"],
  ["未催付", "客户有明确购买意向但客服没有进行合理催付或跟进", "对话结束前没有任何成交跟进", "客户没有明确购买意向"],
] as const;

const demandTypes = [
  "价格需求",
  "功能需求",
  "尺寸需求",
  "颜色款式需求",
  "材质需求",
  "套餐需求",
  "物流时效需求",
  "售后保障需求",
  "其他需求",
];

const summaryPrompt = `仅依据本行聊天截图，客观还原客户、客服和系统消息中明确出现的聊天事实。
按沟通顺序概述客户提出的问题、限制条件、客服回复和最终对话走向。
不得分析未成交原因，不得判断责任，不得提供建议，不得补充截图外信息。
截图无法识别或没有有效聊天内容时，明确输出“信息不足，无法还原聊天事实”。`;

const attributionPrompt = `根据截图内容总结完成一次统一未成交归因。
客户原因和客服原因只能从系统提供的对应知识库候选名称中选择，每类输出 1-2 个；证据不足时不得强行归类。
客户需求类型输出 1-2 个，并保留客户明确提出的具体需求。
每个结果必须包含原文依据和 0-1 置信度，同时输出整体原文依据与整体置信度。`;

function ensureBase(
  db: any,
  id: string,
  name: string,
  columns: Array<{ name: string; roles: string[] }>,
  timestamp: string,
) {
  db.prepare(`
    INSERT INTO knowledge_bases (
      id, section_id, name, original_filename, column_schema_json,
      item_count, is_enabled, created_at, updated_at
    ) VALUES (?, 'lost-deal', ?, '系统初始化', ?, 0, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      column_schema_json = excluded.column_schema_json,
      is_enabled = 1,
      updated_at = excluded.updated_at
  `).run(id, name, JSON.stringify(columns), timestamp, timestamp);
}

function ensureItem(
  db: any,
  baseId: string,
  nameColumn: string,
  name: string,
  definition: string,
  condition: string,
  excluded: string,
  index: number,
  timestamp: string,
) {
  const id = `${baseId}-${index + 1}`;
  const values = {
    [nameColumn]: name,
    定义: definition,
    适用条件: condition,
    排除条件: excluded,
  };
  const pathKey = JSON.stringify([name]);
  const searchText = `${name} ${definition} ${condition} ${excluded}`;
  db.prepare(`
    INSERT INTO knowledge_items (
      id, knowledge_base_id, path_key, values_json, search_text,
      is_enabled, source_row_number, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      path_key = excluded.path_key,
      values_json = excluded.values_json,
      search_text = excluded.search_text,
      is_enabled = 1,
      source_row_number = excluded.source_row_number,
      updated_at = excluded.updated_at
  `).run(id, baseId, pathKey, JSON.stringify(values), searchText, index + 1, timestamp, timestamp);
  db.prepare("DELETE FROM knowledge_item_fts WHERE item_id = ?").run(id);
  db.prepare(`
    INSERT INTO knowledge_item_fts (item_id, knowledge_base_id, search_text)
    VALUES (?, ?, ?)
  `).run(id, baseId, searchText);
}

function ensureField(db: any, input: {
  key: string;
  label: string;
  type: string;
  prompt: string;
  options?: string[];
  outputColumn: string | null;
  imageEnabled: boolean;
  dependsOn: string[];
  sortOrder: number;
  executionType: string;
  exportEnabled: boolean;
}, timestamp: string) {
  const existing = db.prepare(
    "SELECT id FROM analysis_fields WHERE section_id = 'lost-deal' AND key = ?",
  ).get(input.key) as { id: string } | undefined;
  const id = existing?.id ?? `lost-deal-${crypto.createHash("sha1").update(input.key).digest("hex").slice(0, 12)}`;
  db.prepare(`
    INSERT INTO analysis_fields (
      id, section_id, key, label, field_type, prompt, options_json, output_column,
      is_required, image_enabled, depends_on_json, sort_order, execution_type,
      export_enabled, knowledge_base_id, candidate_limit, match_field_key,
      knowledge_column, knowledge_sync_enabled, knowledge_capture_limit,
      is_enabled, created_at, updated_at
    ) VALUES (?, 'lost-deal', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, 15, NULL, NULL, ?, 2, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      field_type = excluded.field_type,
      prompt = excluded.prompt,
      options_json = excluded.options_json,
      output_column = excluded.output_column,
      image_enabled = excluded.image_enabled,
      depends_on_json = excluded.depends_on_json,
      sort_order = excluded.sort_order,
      execution_type = excluded.execution_type,
      export_enabled = excluded.export_enabled,
      is_enabled = 1,
      updated_at = excluded.updated_at
  `).run(
    id,
    input.key,
    input.label,
    input.type,
    input.prompt,
    JSON.stringify(input.options ?? []),
    input.outputColumn,
    input.imageEnabled ? 1 : 0,
    JSON.stringify(input.dependsOn),
    input.sortOrder,
    input.executionType,
    input.exportEnabled ? 1 : 0,
    input.executionType === "lost_deal_attribution" ? 1 : 0,
    timestamp,
    timestamp,
  );
}

export function applyLostDealAnalysisConfiguration(db: any) {
  const section = db.prepare("SELECT id FROM analysis_sections WHERE id = 'lost-deal'").get();
  if (!section) return;
  const timestamp = new Date().toISOString();
  ensureBase(db, CUSTOMER_BASE_ID, "客户未成交原因库", [
    { name: "原因名称", roles: ["result", "search"] },
    { name: "定义", roles: ["description", "search"] },
    { name: "适用条件", roles: ["positive_example", "search"] },
    { name: "排除条件", roles: ["negative_example", "search"] },
  ], timestamp);
  ensureBase(db, SERVICE_BASE_ID, "客服促单问题库", [
    { name: "问题名称", roles: ["result", "search"] },
    { name: "定义", roles: ["description", "search"] },
    { name: "适用条件", roles: ["positive_example", "search"] },
    { name: "排除条件", roles: ["negative_example", "search"] },
  ], timestamp);
  customerReasons.forEach((item, index) => ensureItem(
    db, CUSTOMER_BASE_ID, "原因名称", item[0], item[1], item[2], item[3], index, timestamp,
  ));
  serviceReasons.forEach((item, index) => ensureItem(
    db, SERVICE_BASE_ID, "问题名称", item[0], item[1], item[2], item[3], index, timestamp,
  ));
  db.prepare(`
    UPDATE knowledge_bases
    SET item_count = (SELECT COUNT(*) FROM knowledge_items WHERE knowledge_base_id = knowledge_bases.id),
        updated_at = ?
    WHERE id IN (?, ?)
  `).run(timestamp, CUSTOMER_BASE_ID, SERVICE_BASE_ID);

  ensureField(db, {
    key: "截图内容总结",
    label: "截图内容总结",
    type: "string",
    prompt: summaryPrompt,
    outputColumn: "截图内容总结",
    imageEnabled: true,
    dependsOn: [],
    sortOrder: 0,
    executionType: "ai",
    exportEnabled: true,
  }, timestamp);
  ensureField(db, {
    key: "未成交归因",
    label: "未成交归因",
    type: "object",
    prompt: attributionPrompt,
    options: demandTypes,
    outputColumn: null,
    imageEnabled: false,
    dependsOn: ["截图内容总结"],
    sortOrder: 1,
    executionType: "lost_deal_attribution",
    exportEnabled: false,
  }, timestamp);
  for (const [index, key] of ["客户原因", "客服原因", "客户产品需求"].entries()) {
    ensureField(db, {
      key,
      label: key,
      type: "string",
      prompt: "",
      outputColumn: key,
      imageEnabled: false,
      dependsOn: ["未成交归因"],
      sortOrder: index + 2,
      executionType: "lost_deal_derive",
      exportEnabled: true,
    }, timestamp);
  }
  ensureField(db, {
    key: "话术逻辑优化建议",
    label: "话术逻辑优化建议",
    type: "string",
    prompt: "默认根据统一归因结果使用本地规则生成建议；需要润色时再单独调用 AI。",
    outputColumn: "话术逻辑优化建议",
    imageEnabled: false,
    dependsOn: ["未成交归因"],
    sortOrder: 5,
    executionType: "lost_deal_script",
    exportEnabled: true,
  }, timestamp);
  db.prepare(`
    UPDATE analysis_fields
    SET is_enabled = 0, export_enabled = 0, updated_at = ?
    WHERE section_id = 'lost-deal' AND key IN ('reason', 'evidence', 'confidence')
  `).run(timestamp);
}

export function applyLostDealAnalysis(db: any) {
  applyLostDealAnalysisConfiguration(db);
}
