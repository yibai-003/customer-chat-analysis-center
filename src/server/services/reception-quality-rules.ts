export type ReceptionIssueScope = "preSale" | "afterSale";

export const RECEPTION_EXCEL_FIELDS = [
  "平台", "店铺", "日期", "客服", "客户ID", "分组", "平台店铺商品编码", "商品名称", "聊天截图", "订单号",
  "颜色款式", "品类", "问题点-售前", "问题点-售后", "有无违规-售后", "客服问题 识别问题并打标签",
  "接待流程质检结果", "优化建议-售前", "组长复检文本", "创建时间",
];

export const RECEPTION_AI_SOURCE_FIELDS = RECEPTION_EXCEL_FIELDS.slice(0, 12);
export const RECEPTION_MODERN_AI_SOURCE_FIELDS = [
  "平台 (platform_name)",
  "店铺 (store_name)",
  "业务日期 (business_date)",
  "会话开始时间 (conversation_started_at)",
  "客服 (agent_name)",
  "分组 (agent_group)",
  "客户ID (customer_id)",
  "会话ID (conversation_id)",
  "对话轮数 (turn_count)",
];

export const RECEPTION_RESULT_COLUMNS = [
  "问题点-售前",
  "问题点-售后",
  "有无违规-售后",
  "客服问题 识别问题并打标签",
  "接待流程质检结果",
  "优化建议-售前",
];

export const RECEPTION_COMPLETE_HISTORY_REQUIRED_COLUMNS = [...RECEPTION_RESULT_COLUMNS];

export function receptionAiSourceFields(sourceFields: Record<string, string>) {
  const normalized = Object.fromEntries(Object.entries(sourceFields)
    .map(([key, value]) => [key.trim(), value] as const));
  if (!normalized["平台店铺商品编码"] && normalized["商品编码"]) {
    normalized["平台店铺商品编码"] = normalized["商品编码"];
  }
  return Object.fromEntries([...RECEPTION_AI_SOURCE_FIELDS, ...RECEPTION_MODERN_AI_SOURCE_FIELDS]
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .filter((key) => normalized[key] !== undefined)
    .map((key) => [key, normalized[key]]));
}

export interface ReceptionIssueRule {
  id: string;
  name: string;
  dimension: string;
  scope: ReceptionIssueScope;
  criterion: string;
  deduction: number;
  forceD: boolean;
  violationCount: number;
  priority: number;
  suggestion: string;
  applicableWhen: string[];
  triggerWhen: string[];
  exclusions: string[];
  requiredEvidence: string[];
  missingDataOutcome: "not_applicable" | "blocking_review" | "informational";
}

type RuleDetail = Pick<ReceptionIssueRule,
  "applicableWhen" | "triggerWhen" | "exclusions" | "requiredEvidence" | "missingDataOutcome">;

const detail = (
  applicableWhen: string[],
  triggerWhen: string[],
  exclusions: string[],
  requiredEvidence: string[],
  missingDataOutcome: RuleDetail["missingDataOutcome"] = "informational",
): RuleDetail => ({ applicableWhen, triggerWhen, exclusions, requiredEvidence, missingDataOutcome });

const RULE_DETAILS: Record<string, RuleDetail> = {
  PRE_DUPLICATE: detail(["存在人工客服消息"], ["客服连续2次及以上手动发送完全相同话术"], ["机器人或系统自动消息", "内容不完全一致"], ["连续对话原文"]),
  PRE_FALSE_PROMOTION: detail(["客服明确介绍商品效果、详情或保障"], ["出现无依据的必然效果、绝对结果或无效退款等承诺"], ["仅客观转述有权威依据的商品信息"], ["客服原文", "商品资料或权威规则"], "blocking_review"),
  PRE_RESPONSE_TIMEOUT: detail(["存在可靠且连续的双方消息时间"], ["人工客服平均响应时长超过30秒"], ["缺少可靠时间戳", "机器人响应不计入人工响应"], ["消息时间戳"], "blocking_review"),
  PRE_LAST_MESSAGE_NON_SERVICE: detail(["会话已有客服有效回复"], ["会话未转交", "最后一个有效消息由客户发送"], ["已明确转交", "客户最后一句无需回应"], ["会话末尾原文", "转交状态"], "blocking_review"),
  PRE_PASSIVE_SERVICE: detail(["客服正在人工接待"], ["客服明确推诿、拒绝合理接待，或使用生硬敷衍的单字和单独符号回复"], ["简短但完整且与问题相关的答复"], ["客服原文和上下文"]),
  PRE_MISSED_FOLLOWUP: detail(["客户首句提出明确问题"], ["客服始终没有任何有效响应"], ["客服后续已经实际答复", "仅判断首轮暂未回复"], ["完整会话原文"]),
  PRE_ANSWER_IRRELEVANT: detail(["客户提出明确问题"], ["客服回复无关内容、长篇话术未回应核心问题，或客户明确指出答非所问"], ["客服为解决问题进行必要的信息确认", "客服后续已补充有效回答"], ["客户问题", "客服回复", "后续对话"]),
  PRE_PRODUCT_KNOWLEDGE_ERROR: detail(["客服回答商品知识问题"], ["回复与商品资料或知识库明确不一致"], ["没有商品资料或权威依据"], ["客服原文", "商品资料或知识库"], "blocking_review"),
  PRE_CAMPAIGN_ERROR: detail(["客服回答活动问题"], ["回复与已提供的活动规则明确不一致"], ["没有活动规则"], ["客服原文", "活动规则"], "blocking_review"),
  PRE_BUSINESS_RULE_ERROR: detail(["客服回答发货、配送或其他业务规则问题"], ["回复与已提供的权威业务规则明确不一致"], ["没有权威业务规则"], ["客服原文", "业务规则"], "blocking_review"),
  PRE_UNRESOLVED: detail(["客户存在明确且客服应处理的核心问题"], ["客服明确推卸责任，或让客户自行处理且未提供必要指导"], ["仅因会话暂未得出最终结果"], ["客户诉求", "客服推责或甩回客户的原文"]),
  PRE_PRODUCT_RECOMMENDATION: detail(["客户明确表达求购或选购意愿", "客服进行了商品推荐"], ["客服未对所推荐商品作必要介绍"], ["客户只询问单一明确商品且无需推荐"], ["客户选购诉求", "客服推荐原文"]),
  PRE_NO_ORDER_GUIDANCE: detail(["当前属于售前对话", "客服已完成有效答疑", "客户尚未下单"], ["客服未进行任何合规催拍或下单引导"], ["客户已下单", "客户明确拒绝购买", "核心问题尚未解决", "缺少订单状态或客户是否下单信息"], ["完整会话", "订单状态或客户明确表述"], "blocking_review"),
  PRE_CHALLENGE_CUSTOMER: detail(["客服回应客户问题"], ["客服使用质疑、责备或贬低式反问"], ["为确认需求而使用的正常疑问句"], ["客服原文和上下文"]),
  PRE_NO_EMPATHY: detail(["客户明确表现出负面情绪"], ["客服未作有效安抚或缓和", "后续回复也未正向承接客户情绪或问题"], ["客户没有明显负面情绪"], ["客户情绪原文", "客服后续回复"]),
  PRE_NO_FOLLOWUP: detail(["问题尚未完结", "根据时序可确认客服应继续处理或回复"], ["客服未及时跟进"], ["会话是否结束、转交或合理等待期无法确认"], ["完整会话时序", "转交或等待状态"], "blocking_review"),
  PRE_IMPOLITE: detail(["存在完整人工接待过程"], ["整体表达明显不符合基本礼貌要求"], ["仅个别句子未包含礼貌词", "机械要求每句话使用礼貌词"], ["完整客服对话"]),
  PRE_AMBIGUOUS: detail(["客服表达涉及关键信息"], ["逻辑不清、指代不明或语法不当，足以产生不同理解"], ["不影响关键信息理解的表达习惯"], ["具体歧义原文", "可能产生的不同理解"]),
  PRE_SELECTIVE_REPLY: detail(["客户同一轮或连续提出2个及以上明确问题"], ["客服只回答部分问题，其他问题后续也未回应"], ["一个回复已完整覆盖多个问题", "客服后续补充回答"], ["客户问题列表", "对应客服回复"]),
  PRE_BAD_ATTITUDE: detail(["存在人工客服表达"], ["辱骂、对骂、讥讽、阴阳怪气、明显不耐烦或单独发送争议符号"], ["正常标点", "脱离上下文的客户单方面评价"], ["客服原文或表情记录", "上下文"]),
  PRE_CROSS_PLATFORM: detail(["客服提及其他平台"], ["客服明确引导客户前往其他平台购买"], ["仅客观提及其他平台且没有购买引导"], ["客服原文"]),
  POST_NO_REPLY: detail(["客户提出明确售后问题、诉求或补充信息"], ["人工客服始终没有任何有效回应"], ["仅首轮暂未回复但后续已有效处理"], ["完整会话原文"]),
  POST_NO_REGISTRATION: detail(["售后要求明确规定本次问题需要登记"], ["后台记录明确显示客服未登记"], ["没有登记要求或后台记录"], ["售后要求", "后台登记记录"], "blocking_review"),
  POST_NO_NOTE: detail(["售后要求明确规定需要订单或售后单备注"], ["后台记录明确显示客服未备注"], ["没有备注要求或后台记录"], ["售后要求", "后台备注记录"], "blocking_review"),
  POST_NO_RESEND: detail(["已确认需要补发且客服应执行补发"], ["后台记录明确显示未创建、未提交或未完成补发"], ["只有聊天中的补发承诺但没有后台结果"], ["补发要求", "后台补发记录"], "blocking_review"),
  POST_REGISTRATION_ERROR: detail(["客服已经完成登记"], ["登记中的商品、数量、金额、地址、原因或处理类型与聊天或订单明确不一致"], ["没有登记记录"], ["登记记录", "聊天或订单正确值"], "blocking_review"),
  POST_CHAT_CAUSED_COMPLAINT: detail(["客户实际产生投诉或差评"], ["有明确证据表明投诉或差评由本次客服聊天、态度或处理行为直接引发"], ["客户原本因商品或物流问题准备投诉"], ["投诉或差评证据", "与客服行为的直接因果证据"], "blocking_review"),
  POST_REFUND_COMPLAINT_ERROR: detail(["发生退款或投诉处理"], ["金额或处理发生明确错误", "错误造成实际损失", "客服未第一时间挽回或挽回失败"], ["缺少退款流水、金额、损失或挽回结果"], ["退款流水", "金额", "损失与挽回记录"], "blocking_review"),
  POST_REFUND_REJECT_NO_EVIDENCE: detail(["客服拒绝退款", "售后要求规定必须核实、联系快递并上传凭证"], ["记录明确显示必要核实、取证或上传动作未完成"], ["缺少售后要求、快递记录或售后单记录"], ["售后要求", "快递记录", "售后单记录"], "blocking_review"),
  POST_BAD_PROCESS_OR_PRIVACY: detail(["客服处理售后问题"], ["提供明确错误的售后信息、泄露敏感信息，或存在有原文证据的劣质服务"], ["客户仅不同意处理方案", "没有订单、规则或SOP依据却判断回复错误"], ["客服原文", "订单、规则或SOP依据"]),
  POST_ATTITUDE: detail(["存在人工客服表达"], ["辱骂、威胁、嘲讽、讥讽、人身攻击、争吵或对骂"], ["仅客户情绪激动但客服保持专业"], ["客服原文"]),
  POST_COLD_DELAY: detail(["客服具备继续处理条件"], ["明显冷漠不耐烦、无关敷衍、故意拖延、多次等待不说明进度或消极回避"], ["正常核实或等待系统、快递反馈，且说明原因和后续动作"], ["客服原文", "处理时序"]),
  POST_ABANDON_COMPLAINT: detail(["客户明确提出差评、投诉、平台介入或工商投诉"], ["客服没有任何安抚、解释、协商或解决尝试", "客服放任会话结束或明显不再处理"], ["客服已积极处理但客户仍坚持投诉"], ["客户投诉原文", "客服后续处理"]),
  POST_SOP_VIOLATION: detail(["已提供适用于当前问题的售后SOP"], ["客服处理明显不符合SOP", "客服同时存在敷衍态度"], ["没有提供适用SOP"], ["适用SOP", "客服实际处理原文"], "blocking_review"),
  POST_CHALLENGE_CUSTOMER: detail(["客服回应售后问题"], ["以责备、讽刺或不耐烦方式质问反问，未经核实直接否定，或不当质疑客户"], ["正常核实订单、商品状态或退款原因", "依据明确证据礼貌说明事实"], ["客服原文和上下文"]),
};

const RULE_DIMENSIONS: Record<string, string> = {
  PRE_DUPLICATE: "服务规范",
  PRE_FALSE_PROMOTION: "业务准确性",
  PRE_RESPONSE_TIMEOUT: "响应时效",
  PRE_LAST_MESSAGE_NON_SERVICE: "响应时效",
  PRE_PASSIVE_SERVICE: "服务态度",
  PRE_MISSED_FOLLOWUP: "响应时效",
  PRE_ANSWER_IRRELEVANT: "问题解决",
  PRE_PRODUCT_KNOWLEDGE_ERROR: "业务准确性",
  PRE_CAMPAIGN_ERROR: "业务准确性",
  PRE_BUSINESS_RULE_ERROR: "业务准确性",
  PRE_UNRESOLVED: "问题解决",
  PRE_PRODUCT_RECOMMENDATION: "销售引导",
  PRE_NO_ORDER_GUIDANCE: "销售引导",
  PRE_CHALLENGE_CUSTOMER: "服务态度",
  PRE_NO_EMPATHY: "服务态度",
  PRE_NO_FOLLOWUP: "响应时效",
  PRE_IMPOLITE: "服务态度",
  PRE_AMBIGUOUS: "表达规范",
  PRE_SELECTIVE_REPLY: "问题解决",
  PRE_BAD_ATTITUDE: "服务态度",
  PRE_CROSS_PLATFORM: "销售合规",
  POST_NO_REPLY: "响应时效",
  POST_NO_REGISTRATION: "售后执行",
  POST_NO_NOTE: "售后执行",
  POST_NO_RESEND: "售后执行",
  POST_REGISTRATION_ERROR: "售后执行",
  POST_CHAT_CAUSED_COMPLAINT: "投诉风险",
  POST_REFUND_COMPLAINT_ERROR: "售后执行",
  POST_REFUND_REJECT_NO_EVIDENCE: "售后执行",
  POST_BAD_PROCESS_OR_PRIVACY: "业务合规",
  POST_ATTITUDE: "服务态度",
  POST_COLD_DELAY: "响应时效",
  POST_ABANDON_COMPLAINT: "投诉风险",
  POST_SOP_VIOLATION: "售后执行",
  POST_CHALLENGE_CUSTOMER: "服务态度",
};

const preSaleRules = [
  ["PRE_DUPLICATE", "重复发送", "客服连续两次及以上手动发送完全相同的话术。", 2, false, 1, "合并重复话术，确认客户的新问题后再回复。"],
  ["PRE_FALSE_PROMOTION", "违反宣传", "客服在无权威依据时作出绝对效果、必然结果或无效退款等过度承诺。", 5, false, 1, "仅依据商品资料说明效果和保障，避免绝对化承诺。"],
  ["PRE_RESPONSE_TIMEOUT", "平均响应超时", "可靠时间戳显示人工客服平均响应时长超过30秒。", 1, false, 1, "缩短人工响应间隔；繁忙时先告知正在核实。"],
  ["PRE_LAST_MESSAGE_NON_SERVICE", "最后一句非客服发送", "会话已结束且最后一个有效消息来自客户，客服没有后续回应。", 2, false, 1, "在会话结束前确认客户问题已处理并完成收尾。"],
  ["PRE_PASSIVE_SERVICE", "服务消极D级", "客服明确拒绝合理接待、推诿或消极终止服务。", 5, true, 1, "承接客户诉求并明确下一步处理动作，避免推诿。"],
  ["PRE_MISSED_FOLLOWUP", "漏跟进", "客户首句提出明确问题后，客服没有任何有效响应。", 5, false, 1, "识别客户首要问题并在首次人工回复中有效承接。"],
  ["PRE_ANSWER_IRRELEVANT", "答非所问", "客服回复与客户明确问题无关，且后续没有补充有效回答。", 10, false, 1, "先直接回答客户核心问题，再补充相关说明。"],
  ["PRE_PRODUCT_KNOWLEDGE_ERROR", "商品知识回复错误", "客服回复与已提供的商品资料或知识库明确不一致。", 2, false, 1, "回复商品信息前核对商品资料或知识库。"],
  ["PRE_CAMPAIGN_ERROR", "活动回复错误", "客服回复与已提供的活动规则明确不一致。", 2, false, 1, "核对当前活动规则后再说明优惠条件。"],
  ["PRE_BUSINESS_RULE_ERROR", "业务规则回复错误", "客服回复与已提供的发货、配送等权威业务规则明确不一致。", 2, false, 1, "依据最新业务规则说明发货和配送信息。"],
  ["PRE_UNRESOLVED", "问题未解决D级", "客服具备处理条件却未提供有效答案或方案，导致核心问题明确未解决。", 10, true, 1, "围绕核心诉求给出明确答案、方案和下一步。"],
  ["PRE_PRODUCT_RECOMMENDATION", "未正确推荐介绍商品", "客户存在明确选购需求，客服未结合需求推荐或介绍适合商品。", 5, false, 1, "先确认使用场景和关键条件，再给出匹配的商品建议。"],
  ["PRE_NO_ORDER_GUIDANCE", "未及时催拍", "客服已完成答疑、客户尚未下单且具备自然引导条件，但未作任何合规下单引导。", 10, false, 1, "答疑完成后使用礼貌、不施压的下单引导。"],
  ["PRE_CHALLENGE_CUSTOMER", "反问/质疑顾客D级", "客服使用带责备、贬低或讽刺含义的反问质疑客户。", 5, true, 1, "改用中性确认句核实信息，避免责备式反问。"],
  ["PRE_NO_EMPATHY", "未有效安抚客户情绪D级", "客户明确表现负面情绪，客服未作任何安抚或正向承接。", 5, true, 1, "先回应客户情绪，再说明解决方案和处理进度。"],
  ["PRE_NO_FOLLOWUP", "解决问题未跟进", "问题尚未完结且可确认客服应继续处理，但客服没有跟进。", 5, false, 1, "明确处理节点并主动同步后续进展。"],
  ["PRE_IMPOLITE", "未使用礼貌用语", "完整接待过程缺少基本礼貌表达，整体语气明显不符合服务要求。", 5, false, 1, "在关键回复中使用自然、必要的礼貌表达。"],
  ["PRE_AMBIGUOUS", "表达有歧义", "客服关键表述指代不明或逻辑不清，足以造成不同理解。", 5, false, 1, "使用明确主语、条件和结论，避免模糊指代。"],
  ["PRE_SELECTIVE_REPLY", "选择性回复", "客户提出两个及以上明确问题，客服仅回答部分且后续未补充。", 10, false, 1, "逐项回应客户问题，遗漏项应在后续补充。"],
  ["PRE_BAD_ATTITUDE", "态度差D级", "客服辱骂、讥讽、争吵、明显不耐烦或使用争议符号表达。", 10, true, 1, "保持专业克制，禁止讥讽、争吵和情绪化回复。"],
  ["PRE_CROSS_PLATFORM", "跨平台引导", "客服引导客户前往其他平台购买。", 10, true, 1, "禁止引导客户跨平台购买，按当前平台规范提供服务。"],
].map(([id, name, criterion, deduction, forceD, violationCount, suggestion], index): ReceptionIssueRule => ({
  id: id as string,
  name: name as string,
  dimension: RULE_DIMENSIONS[id as string],
  scope: "preSale" as const,
  criterion: criterion as string,
  deduction: deduction as number,
  forceD: forceD as boolean,
  violationCount: violationCount as number,
  priority: forceD ? index : 100 + index,
  suggestion: suggestion as string,
  ...RULE_DETAILS[id as string],
}));

const afterSaleRules = [
  ["POST_NO_REPLY", "漏回复", "客户提出明确售后诉求或补充信息后，人工客服没有任何有效回应。", 1, false, 1, "有效承接售后诉求并说明下一步处理动作。"],
  ["POST_NO_REGISTRATION", "漏登记", "规则要求登记且后台记录明确显示未登记。", 1, false, 1, "按售后要求完成登记并核对记录。"],
  ["POST_NO_NOTE", "漏备注", "规则要求备注且后台记录明确显示未备注。", 1, false, 1, "完成订单或售后单备注并核对内容。"],
  ["POST_NO_RESEND", "漏补发", "已确认需要补发，后台记录明确显示未创建或未完成补发。", 2, false, 1, "确认补发后及时创建记录并跟进结果。"],
  ["POST_REGISTRATION_ERROR", "登记错误", "登记内容与聊天或订单中的商品、数量、金额、地址、原因等明确信息不一致。", 3, false, 1, "登记前逐项核对订单和客户确认信息。"],
  ["POST_CHAT_CAUSED_COMPLAINT", "因聊天引发投诉或差评", "投诉或差评由本次客服态度或处理行为直接引发。", 10, true, 1, "及时安抚并纠正不当沟通，避免服务问题升级。"],
  ["POST_REFUND_COMPLAINT_ERROR", "退款或投诉处理错误", "退款或投诉处理发生明确错误并造成实际损失，且未及时挽回。", 10, true, 1, "核对金额与处理路径，发现错误后立即补救。"],
  ["POST_REFUND_REJECT_NO_EVIDENCE", "拒绝退款但未按要求核实取证", "规则要求核实、联系快递或上传凭证，记录明确显示客服未完成。", 5, false, 1, "拒绝退款前按规则完成核实和取证。"],
  ["POST_BAD_PROCESS_OR_PRIVACY", "聊天处理错误、信息泄露或劣质服务", "客服提供明确错误信息、泄露敏感信息或存在有证据的劣质服务。", 10, true, 1, "核对处理信息并严格保护客户隐私。"],
  ["POST_ATTITUDE", "态度问题", "客服辱骂、威胁、嘲讽、人身攻击或与客户争吵。", 10, true, 1, "保持专业克制，禁止辱骂、威胁和争吵。"],
  ["POST_COLD_DELAY", "冷漠、不耐烦、敷衍或拖延", "客服无关敷衍、消极回避，或具备处理条件时故意拖延。", 2, false, 1, "说明核实原因和预计进度，持续推进问题处理。"],
  ["POST_ABANDON_COMPLAINT", "买家差评、投诉或工商威胁时放任客户", "客户明确威胁投诉，客服未作安抚、解释、协商或解决尝试。", 5, true, 1, "面对投诉风险应主动安抚并提出可执行方案。"],
  ["POST_SOP_VIOLATION", "未按照售后SOP解决问题且态度敷衍", "已提供适用SOP，客服处理明确不符合SOP且同时态度敷衍。", 5, false, 1, "严格按适用SOP处理并清晰说明流程。"],
  ["POST_CHALLENGE_CUSTOMER", "质问、反问或直接否定客户", "客服以责备、讽刺或不耐烦方式质问、反问，或未经核实直接否定客户。", 5, false, 1, "使用礼貌核实语句，避免未经核实直接否定。"],
].map(([id, name, criterion, deduction, forceD, violationCount, suggestion], index): ReceptionIssueRule => ({
  id: id as string,
  name: name as string,
  dimension: RULE_DIMENSIONS[id as string],
  scope: "afterSale" as const,
  criterion: criterion as string,
  deduction: deduction as number,
  forceD: forceD as boolean,
  violationCount: violationCount as number,
  priority: 200 + index,
  suggestion: suggestion as string,
  ...RULE_DETAILS[id as string],
}));

export const RECEPTION_ISSUE_RULES = [...preSaleRules, ...afterSaleRules];
export const RECEPTION_RULE_BY_ID = new Map(RECEPTION_ISSUE_RULES.map((rule) => [rule.id, rule]));
export const RECEPTION_RULE_BY_NAME = new Map(RECEPTION_ISSUE_RULES.map((rule) => [rule.name, rule]));

export const RECEPTION_SCREENSHOT_FACTS_PROMPT = `只抽取截图事实，不做质检判断。严格返回以下对象字段：
sceneHints：数组，只能包含“售前”“售后”或“无法判断”；
dialogueTurns：按顺序输出对话，元素为 {id:"T1",speaker:"客户|客服|机器人|系统|无法判断",time:"原文时间或空字符串",text:"原文"}；
customerIntents：客户明确诉求数组；
serviceActions：客服明确执行的回复、解释、推荐、安抚、催拍、转交、登记或收尾行为数组；
businessFacts：商品、规格、数量、订单、活动、物流、时间等明确事实数组；
missingSignals：截图无法确认但后续质检可能需要的信息数组。
禁止虚构、评价、判违规、打分或给建议。无法识别时保留空数组，并在 missingSignals 说明原因。`;

export const RECEPTION_QUALITY_FIELD_PROMPT = `依据“截图内容总结”和辅助字段完成一次统一接待质检。
先识别售前、售后、混合或无法判断场景，再逐项核查当前场景对应的全部问题ID，不得跳项。
每项必须同时检查适用条件、触发条件和排除条件；只有适用且完整满足触发条件、同时不命中排除条件时才能判违规。
结论必须引用可回溯的对话编号或明确辅助数据。缺少规则要求的关键证据时不得判违规；仅当缺失信息会改变本次结论时才进入人工复核。
只输出问题ID、证据编号、最小必要原文、判定理由、规则覆盖清单和置信度。
分数、等级、违规次数、标签和整改建议全部由本地规则生成。不得重复生成聊天总结或固定文字质检报告。`;

export function receptionIssueCatalogPrompt(scopes: ReceptionIssueScope[] = ["preSale", "afterSale"]) {
  return RECEPTION_ISSUE_RULES
    .filter((rule) => scopes.includes(rule.scope))
    .map((rule) => [
      rule.id,
      rule.name,
      rule.dimension,
      rule.scope === "preSale" ? "售前" : "售后",
      `适用:${rule.applicableWhen.join("；")}`,
      `违规:${rule.triggerWhen.join("；")}`,
      `排除:${rule.exclusions.join("；") || "无"}`,
      `证据:${rule.requiredEvidence.join("；")}`,
      `缺失:${rule.missingDataOutcome}`,
    ].join("|"))
    .join("\n");
}
