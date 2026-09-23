export const RECEPTION_V4_SOURCE_FIELDS = [
  "平台 (platform_name)",
  "店铺 (store_name)",
  "业务日期 (business_date)",
  "会话开始时间 (conversation_started_at)",
  "客服 (agent_name)",
  "分组 (agent_group)",
  "客户ID (customer_id)",
  "会话ID (conversation_id)",
  "对话轮数 (turn_count)",
  "等级 (rating)",
  "合计扣分 (total_deduction)",
  "优化建议 (improvement_advice)",
  "是否待人工复核 (needs_manual_review)",
  "聊天截图 (chat_screenshot)",
  "维度 (dimension)",
  "问题 (issue)",
  "扣分 (deduction)",
  "是否D级 (d_level)",
  "聊天原文 (chat_excerpt)",
  "证据说明 (evidence)",
  "判定理由 (judgement_reason)",
] as const;

export const RECEPTION_V4_RESULT_FIELDS = [
  "会话开始时间 (conversation_started_at)",
  "会话ID (conversation_id)",
  "对话轮数 (turn_count)",
  "等级 (rating)",
  "合计扣分 (total_deduction)",
  "优化建议 (improvement_advice)",
  "是否待人工复核 (needs_manual_review)",
  "维度 (dimension)",
  "问题 (issue)",
  "扣分 (deduction)",
  "是否D级 (d_level)",
  "聊天原文 (chat_excerpt)",
  "证据说明 (evidence)",
  "判定理由 (judgement_reason)",
] as const;

export const RECEPTION_V4_SCREENSHOT_FACTS_PROMPT = `只做聊天截图的客观事实抽取，不做质检判断。
请按截图中可见内容还原消息顺序、说话人、时间、客户诉求、客服动作和业务事实。
必须区分客户、人工客服、机器人和系统消息；机器人或系统消息不得标记为客服。
time 只能抄录截图中可见的时间原文，无法确认时填写空字符串；不得使用业务日期、导入时间或会话ID推算时间。
sceneHints 只能填写售前、售后或无法判断；无法可靠判断时填写无法判断。
辅助字段只用于理解上下文，不能替代截图证据；模板中已有的历史结果列不能作为本次截图事实的依据。
不要输出问题、维度、扣分、等级、D级、建议或任何质检结论。
无法识别的内容保留空数组，并在 missingSignals 中说明原因。
只返回指定字段的严格 JSON，不要输出 Markdown、解释文字或额外字段。`;

export const RECEPTION_V4_QUALITY_PROMPT = `依据“截图内容总结”和新模板的辅助字段完成一次统一接待质检。
先判断场景为售前、售后、混合或无法判断，再逐项检查当前场景适用的问题目录；不得跳过适用规则。
每个问题必须同时满足适用条件和触发条件，并且不能命中排除条件，才可以输出问题ID。
每个输出问题必须绑定至少一个真实对话编号 evidenceIds，并提供最小必要的原文、证据说明和判定理由。
没有截图原文、可靠时间、订单或业务记录等规则要求的关键证据时，不得臆测违规；若缺失信息可能改变结论，放入 blockingUnverifiableItems 并要求人工复核。
仅影响解释完整度但不改变结论的缺失信息放入 informationalUnverifiableItems。
checkedRuleIds 必须包含本次场景实际逐项检查过的全部规则ID；不适用或合规规则不得进入问题数组。
不得输出问题名称、维度、扣分、D级、总分、等级、标签或建议，这些结果由本地版本规则和导出映射生成。
模板中已有的结果列、旧版本结果或会话ID不能作为质检证据；会话ID由系统生成。
只返回指定字段的严格 JSON，不要输出 Markdown、解释文字或额外字段。`;
