export const RECEPTION_V2_SCREENSHOT_FACTS_PROMPT = `只抽取截图事实，不做质检判断。严格返回以下对象字段：
sceneHints：数组，只能包含“售前”“售后”或“无法判断”；它只是场景线索，质检时不得据此删减任何规则；
dialogueTurns：按顺序输出对话，元素为 {id:"T1",speaker:"客户|客服|机器人|系统|无法判断",time:"原文时间或空字符串",text:"原文"}；
customerIntents：客户明确诉求数组；
serviceActions：人工客服明确执行的行为数组；
businessFacts：截图中明确出现的业务事实数组；
missingSignals：截图无法确认但后续质检可能需要的信息数组。
区分人工客服、机器人和系统消息。禁止虚构、评价、判违规、打分或给建议。无法识别时保留空数组，并在 missingSignals 说明原因。`;

export const RECEPTION_V2_QUALITY_PROMPT = `依据一次截图事实抽取、辅助字段和任务绑定版本知识快照完成接待质检。
必须逐项检查完整规则目录中的每一条规则并返回一个 ruleChecks 项。sceneHints 仅供参考，不得用于删减规则。
scene 为“售前”时，售后规则必须标记 not_applicable；scene 为“售后”时，售前规则必须标记 not_applicable；“混合”和“无法判断”场景下所有规则均适用。
status 只能为 violation、compliant、needs_review、not_applicable。checkedRuleIds 必须精确等于所有非 not_applicable 规则的 ID 集合。
每个 ruleChecks 项必须包含 ruleId、status、evidence、evidenceExplanation 和 reason。violation 必须包含至少一个有效 dialogue 证据引用；不得引用不存在的 ID 或伪造原文。
dialogue 引用格式为 {source:"dialogue",id:"T2",quote:"逐字包含于该轮原文的片段"}。source_field 引用格式为 {source:"source_field",id:"源字段原名",value:"字段原值"}。knowledge 引用格式为 {source:"knowledge",id:"baseId/itemId",value:"该知识条目 values 的精确 JSON 字符串}。backend_record 引用格式为 {source:"backend_record",id:"记录标识"}；当前没有后台凭证输入，必须将依赖此来源的结论标记为 needs_review。
缺少规则要求的阻塞证据时不得判为 violation 或 compliant，应标记 needs_review 并说明缺失；不影响本次结论的信息列入 informationalUnverifiableItems。
只返回严格 JSON，不得增加字段：{scene,checkedRuleIds,ruleChecks,blockingUnverifiableItems,informationalUnverifiableItems,confidence}。
不得返回问题名称、维度、扣分、违规次数、D 级、总分、等级、标签或建议；这些结果全部由本地规则生成。不得读取或依赖工作簿历史质检结果列。`;
