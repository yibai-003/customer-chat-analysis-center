import crypto from "node:crypto";
import { applyLostDealAnalysisConfiguration } from "./migrations/006-lost-deal-analysis";
import { applyReceptionQualityConfiguration } from "./migrations/009-reception-quality-normalization";
import { applyUnifiedReceptionQualityConfiguration } from "./migrations/010-unified-reception-quality";
import { applyOptimizedReceptionQualityConfiguration } from "./migrations/011-optimized-reception-quality-prompts";
import { applyReceptionExcelSchemaConfiguration } from "./migrations/013-reception-excel-schema";
import { ensureSectionConfigV1 } from "./migrations/018-section-config-versions";
import { applyReceptionImportContract } from "./migrations/022-reception-import-contract";
import { applyReceptionTwoStageAnalysis } from "./migrations/023-reception-two-stage-analysis";
import { applyReceptionScreenshotRowExport } from "./migrations/024-reception-screenshot-row-export";
export function seedNewDatabase(db: any) {
  seedSections(db);
  migrateLegacyFields(db);
  migrateRefundAnalysisFields(db);
  applyLostDealAnalysisConfiguration(db);
  applyReceptionQualityConfiguration(db);
  applyUnifiedReceptionQualityConfiguration(db);
  applyOptimizedReceptionQualityConfiguration(db);
  applyReceptionExcelSchemaConfiguration(db);
  ensureSectionConfigV1(db);
  applyReceptionImportContract(db);
  applyReceptionTwoStageAnalysis(db);
  applyReceptionScreenshotRowExport(db);
}
function seedSections(db: any) {
  const count = db.prepare("SELECT COUNT(*) as count FROM analysis_sections").get().count as number;
  if (count > 0) return;
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO analysis_sections
    (id,parent_id,name,prompt,output_schema_json,sort_order,is_enabled,created_at,updated_at)
    VALUES (@id,@parentId,@name,@prompt,@schema,@sortOrder,1,@now,@now)`);
  const seed = [
    ["chat", null, "聊天问题", "识别本段客服聊天的核心问题。", [], 1],
    ["reception", "chat", "接待流程质检", "检查客服是否完成问候、需求确认、方案说明和下一步引导。", [
      { key: "conclusion", label: "质检结论", type: "string", required: true },
      { key: "issueType", label: "问题类型", type: "string" },
      { key: "suggestion", label: "改进建议", type: "string" },
      { key: "confidence", label: "置信度", type: "number" },
    ], 2],
    ["lost-deal", "chat", "未成交分析", "分析客户没有成交的主要原因，并引用聊天依据。", [
      { key: "reason", label: "未成交原因", type: "string", required: true },
      { key: "evidence", label: "聊天依据", type: "string" },
      { key: "confidence", label: "置信度", type: "number" },
    ], 3],
    ["hot-topic", "chat", "热点问题", "提炼客户反复出现或具有代表性的热点问题。", [
      { key: "topic", label: "热点主题", type: "string", required: true },
      { key: "summary", label: "问题摘要", type: "string" },
    ], 4],
    ["product", null, "产品问题", "识别与产品、售后或服务相关的问题。", [], 5],
    ["refund", "product", "退货分析", "根据截图解析结果匹配退货原因知识库，并提取完整原因路径。", [
      { key: "reason", label: "截图解析", type: "object", required: true },
      { key: "responsibility", label: "责任归因", type: "string" },
      { key: "suggestion", label: "改进建议", type: "string" },
    ], 6],
  ];
  for (const [id, parentId, name, prompt, schema, sortOrder] of seed) {
    insert.run({ id, parentId, name, prompt, schema: JSON.stringify(schema), sortOrder, now });
  }
}

function migrateLegacyFields(db: any) {
  const sections = db.prepare("SELECT * FROM analysis_sections").all() as any[];
  const insert = db.prepare(`INSERT OR IGNORE INTO analysis_fields
    (id,section_id,key,label,field_type,prompt,options_json,output_column,is_required,image_enabled,depends_on_json,sort_order,is_enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`);
  const transaction = db.transaction(() => {
    for (const section of sections) {
      const schema = JSON.parse(section.output_schema_json || "[]") as Array<{
        key: string; label: string; type: string; required?: boolean;
      }>;
      schema.forEach((field, index) => {
        insert.run(
          `legacy-${section.id}-${field.key}`,
          section.id,
          field.key,
          field.label,
          field.type,
          section.prompt,
          "[]",
          field.label,
          field.required ? 1 : 0,
          section.image_enabled === 0 ? 0 : 1,
          "[]",
          index,
          new Date().toISOString(),
          new Date().toISOString(),
        );
      });
    }
  });
  transaction();
}

function migrateRefundAnalysisFields(db: any) {
  const section = db.prepare("SELECT id, prompt, source_fields_json FROM analysis_sections WHERE id = 'refund'").get() as
    | { id: string; prompt: string; source_fields_json: string }
    | undefined;
  if (!section) return;

  const timestamp = new Date().toISOString();
  const existing = (key: string) => db.prepare(
    "SELECT id, prompt, knowledge_base_id, candidate_limit FROM analysis_fields WHERE section_id = 'refund' AND key = ?",
  ).get(key) as
    | { id: string; prompt: string; knowledge_base_id: string | null; candidate_limit: number }
    | undefined;
  const reason = existing("reason");
  if (reason) {
    db.prepare(`UPDATE analysis_fields
      SET label = '截图解析', field_type = 'object', output_column = '截图解析', is_enabled = 1, export_enabled = 1,
          image_enabled = 1, sort_order = 0, updated_at = ?
      WHERE id = ?`).run(timestamp, reason.id);
    const generatedPrompt = `你是售后聊天截图解析员。请根据本行全部聊天截图，提取退货分析所需的客观事实、证据和标准化问题关键词。

输出内容：
客户核心诉求：用一句话说明客户为什么申请售后
问题现象：客观描述商品、订单、物流或服务发生了什么；没有则写“未说明”
关键证据：列出客服确认、实物图片、测量数据、故障代码、检测结果或物流轨迹；没有则写“无有效凭证”
客服处理：退款、退货、补发、补偿、解释、拒绝等；没有则写“未说明”
标准化问题关键词：输出1至3个简短关键词

只根据截图内容作答，不要推断截图中未出现的信息，不要输出责任归因、改进建议或完整分类路径。`;
    if (reason.prompt === generatedPrompt || reason.prompt === section.prompt) {
      db.prepare(`UPDATE analysis_fields
        SET prompt = ?, updated_at = ?
        WHERE id = ?`).run(
        `你是淘系店铺售后聊天记录解析员，负责根据本行聊天截图，提取与售后问题直接相关的客观事实。

【输入内容】

聊天截图：
{{截图内容}}

辅助信息：
- 平台售后问题类型：{{平台售后问题类型}}
- 商品信息：{{商品信息}}
- 产品大类：{{产品大类}}
- 产品分类：{{产品分类}}
- 产品名称：{{产品名称}}

【解析要求】

1. 读取本行全部聊天截图。如果存在多张截图，按照上传顺序，并结合截图中的聊天时间顺序合并理解。

2. 区分消息发送方：
   - 客户
   - 客服/商家
   - 系统或平台消息

3. 只提取与本订单退货、退款、补偿、补发、商品问题、物流问题或售后服务直接相关的内容。

4. 忽略以下内容：
   - 导航栏、头像、昵称、输入框
   - 广告、推荐内容、无关系统通知
   - 表情、重复话术
   - 与本次售后无关的闲聊
   - 不能证明问题的营销或模板话术

5. 对证据进行区分：
   - 客户单方面描述：只能说明客户声称或反馈了某个问题
   - 客服确认：客服明确确认问题、责任或处理结果
   - 图片或测量凭证：聊天中出现的商品图片、故障图片、测量数据、检测结果
   - 物流信息：物流轨迹、揽收、签收、停滞、破损等信息
   - 系统信息：平台自动生成的退款、退货或订单状态

6. 客户单方面说“质量有问题”“不好用”等，只能记录为客户反馈，不能直接认定为质量问题已被证实。除非截图中有客服确认、图片、测量结果、检测结果或其他明确证据。

7. 辅助信息仅用于理解上下文，不能替代聊天证据：
   - 不得仅根据平台售后问题类型推断真实原因
   - 不得仅根据商品信息、产品分类或产品名称推断问题
   - 不得补充截图中没有出现的故障、责任、尺寸、位置、代码或处理结果

8. 如果截图为空、无法识别、不是聊天记录，或没有与售后原因相关的有效内容：
   - 客户核心诉求：信息不足，无法判断客户售后诉求
   - 问题现象：未说明
   - 关键证据：无有效凭证
   - 客服处理：未说明
   - 标准化问题关键词：信息不足
   - 责任线索：无法判断
   - 信息充分度：不足

9. 如果截图中只有客服发言、催促或询问，客户没有任何有效文字、语音转写或明确回应：
   - 客户核心诉求：其他无理由（客户无回复）
   - 问题现象：客户未回复，未提供具体售后原因
   - 关键证据：聊天记录中无客户有效回复
   - 客服处理：根据截图中的实际处理内容填写；没有则写“未说明”
   - 标准化问题关键词：客户无回复
   - 责任线索：客户自身
   - 信息充分度：充分

10. 以下问题仅在截图中明确出现时进行识别，并统一归为“工厂品质”：
   - 产品气味、异味
   - 产品加热、水温、温度过高或过低
   - 升温慢、无法加热、温控异常
   - 保温效果异常

   对上述问题：
   - 责任线索必须填写：工厂品质
   - 不得归为客户自身

   只有明确表达“天气变化、天气变冷或变热，导致客户不再需要该产品”时，责任线索才填写“客户自身”。

11. 聊天截图解析阶段只输出客观事实、证据和标准化问题关键词。
    不要输出完整的二级、三级分类路径，也不要逐项匹配或复述所有分类类目。后续分类由其他字段单独完成。

12. 标准化问题关键词只提取1至3个简短关键词，例如：
    - 客户无回复
    - 产品异味
    - 温度不足
    - 慢漏气
    - 尺寸太大
    - 物流未更新

13. 责任线索只能从以下选项中选择一个：
    - 采购
    - 仓储
    - 工厂品质
    - 客服服务
    - 客户自身
    - 物流
    - 运营页面或活动
    - 平台
    - 主播
    - 供分销
    - 产品设计
    - 特殊售后
    - 无法判断

14. 信息充分度只能填写：
    - 充分
    - 不足

【输出规则】

严格按照以下格式输出，不要增加标题、解释、分析过程、JSON、Markdown代码块或其他内容：

客户核心诉求：用一句话说明客户为什么申请售后
问题现象：客观描述商品、订单、物流或服务发生了什么；没有则写“未说明”
关键证据：列出客服确认、实物图片、测量数据、故障代码、检测结果或物流轨迹；没有则写“无有效凭证”
客服处理：退款、退货、补发、补偿、解释、拒绝等；没有则写“未说明”
标准化问题关键词：输出1至3个简短关键词
责任线索：只能填写一个规定选项
信息充分度：只能填写“充分”或“不足”`,
        timestamp,
        reason.id,
      );
    }
  }
  db.prepare(`UPDATE analysis_fields
    SET is_enabled = 0, export_enabled = 0, updated_at = ?
    WHERE section_id = 'refund' AND key IN ('responsibility', 'suggestion')`).run(timestamp);

  const sourceFields = JSON.parse(section.source_fields_json || "[]") as string[];
  const refundSourceFields = ["售后问题类型", "商品信息", "产品大类", "产品分类", "产品名称"];
  if (!sourceFields.length) {
    db.prepare("UPDATE analysis_sections SET source_fields_json = ?, updated_at = ? WHERE id = 'refund'")
      .run(JSON.stringify(refundSourceFields), timestamp);
  }
  const knowledgeBase = db.prepare(
    "SELECT id FROM knowledge_bases WHERE section_id = 'refund' AND is_enabled = 1 ORDER BY updated_at DESC LIMIT 1",
  ).get() as { id: string } | undefined;
  const matchPrompt = "根据截图解析结果和辅助字段，从退货原因知识库候选中选择最符合本次售后根因的唯一完整路径。只能选择候选条目，不得自建分类；证据不足时留空并进入复核。";
  const insertField = db.prepare(`INSERT INTO analysis_fields
    (id, section_id, key, label, field_type, prompt, options_json, output_column, is_required, image_enabled,
     depends_on_json, sort_order, execution_type, export_enabled, knowledge_base_id, candidate_limit,
     match_field_key, knowledge_column, is_enabled, created_at, updated_at)
    VALUES (?, 'refund', ?, ?, 'string', ?, '[]', ?, 0, ?, ?, ?, ?, ?, ?, 15, ?, ?, 1, ?, ?)`);
  const upsertField = db.prepare(`UPDATE analysis_fields SET label = ?, prompt = ?, output_column = ?, image_enabled = ?,
    depends_on_json = ?, sort_order = ?, execution_type = ?, export_enabled = ?, knowledge_base_id = ?,
    candidate_limit = ?, match_field_key = ?, knowledge_column = ?, is_enabled = 1, updated_at = ? WHERE id = ?`);
  const ensureField = (
    key: string,
    label: string,
    prompt: string,
    outputColumn: string,
    imageEnabled: number,
    dependsOn: string[],
    sortOrder: number,
    executionType: string,
    exportEnabled: number,
    knowledgeBaseId: string | null,
    matchFieldKey: string | null,
    knowledgeColumn: string | null,
  ) => {
    const item = existing(key);
    if (item) {
      upsertField.run(label, prompt, outputColumn, imageEnabled, JSON.stringify(dependsOn), sortOrder, executionType,
        exportEnabled, knowledgeBaseId, item.candidate_limit ?? 15, matchFieldKey, knowledgeColumn, timestamp, item.id);
    } else {
      insertField.run(
        crypto.randomUUID(), key, label, prompt, outputColumn, imageEnabled, JSON.stringify(dependsOn), sortOrder,
        executionType, exportEnabled, knowledgeBaseId, matchFieldKey, knowledgeColumn, timestamp, timestamp,
      );
    }
  };

  ensureField(
    "reasonPathMatch",
    "原因路径匹配",
    matchPrompt,
    "",
    0,
    ["reason", "售后问题类型", "商品信息", "产品分类", "产品名称"],
    1,
    "knowledge_match",
    0,
    knowledgeBase?.id ?? null,
    null,
    null,
  );
  for (const [index, item] of ["一级原因", "二级原因", "三级原因"].entries()) {
    ensureField(
      ["一级选项", "二级选项", "三级选项"][index],
      ["一级选项", "二级选项", "三级选项"][index],
      "",
      ["一级选项", "二级选项", "三级选项"][index],
      0,
      ["reasonPathMatch"],
      index + 2,
      "knowledge_extract",
      1,
      null,
      "reasonPathMatch",
      item,
    );
  }
}
