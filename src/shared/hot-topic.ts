import { DEFAULT_EXECUTION_TYPE, type AnalysisField } from "./types";

export const HOT_TOPIC_SECTION_ID = "hot-topic";
export const HOT_TOPIC_BASE_ID = "hot-topic-auto-questions";
export const HOT_TOPIC_BASE_NAME = "热点话题问题库";
export const HOT_TOPIC_QUESTION_COLUMN = "标准问题";

export function isHotTopicField(field: Pick<AnalysisField, "sectionId" | "key" | "label" | "executionType">) {
  return field.sectionId === HOT_TOPIC_SECTION_ID
    && (field.executionType ?? DEFAULT_EXECUTION_TYPE) === DEFAULT_EXECUTION_TYPE
    && (field.key === "高频问题" || field.label === "高频问题");
}

export const HOT_TOPIC_PROMPT = `仅依据依赖字段中的截图解析或客户问题，提炼客户明确提出的核心问题。
每条记录通常提炼 1 个问题；确有两个独立核心诉求时最多提炼 2 个，没有明确问题时返回空列表，不凑数。
问题使用简短、可复用的标准问法。保留影响语义的产品类型、使用场景和限制条件，去除姓名、电话、订单号、具体订单日期等个体信息。
例如：“我昨天买的这个怎么还没有寄？”可归纳为“订单何时发货？”。
禁止虚构诉求、把客服回答当成客户问题，或将不同问题合并为笼统分类；不生成答案。
系统会优先匹配本板块已启用的问题知识库。同义且适用范围一致时使用已有词条原文，无可靠匹配时补充新词条，无法确定时标记复核。
每个问题必须附有依赖文本中的连续原文作为依据。这里只提炼问题，不声称该问题已经高频；频次按关联的不同记录数统计。
输出格式遵循系统提供的 JSON 协议。`;
