import type { AnalysisField } from "../../shared/types";
import { db } from "../db/client";

export interface LostDealReason {
  knowledgeItemId?: string;
  name: string;
  proposedName?: string;
  evidence: string;
  confidence: number;
}

export interface LostDealAttribution {
  customerReasons: LostDealReason[];
  serviceReasons: LostDealReason[];
  demandTypes: LostDealReason[];
  specificDemand: string;
  specificDemandEvidence: string;
  specificDemandGrounded?: boolean;
  evidence: string[];
  confidence: number;
  reviewRequired: boolean;
}

export interface LostDealKnowledgeCandidates {
  customerReasons: LostDealKnowledgeCandidate[];
  serviceReasons: LostDealKnowledgeCandidate[];
  demandTypes: string[];
}

export interface LostDealKnowledgeCandidate {
  id: string;
  name: string;
  definition: string;
  applicable: string;
  excluded: string;
}

export const LOST_DEAL_CUSTOMER_BASE_NAME = "客户未成交原因库";
export const LOST_DEAL_SERVICE_BASE_NAME = "客服促单问题库";

const REVIEW_NAME = "待复核";
const MIN_CONFIDENCE = 0.5;

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseReasonList(
  value: unknown,
  allowed: Map<string, LostDealKnowledgeCandidate>,
  label: string,
  isGrounded: (evidence: string) => boolean,
): { items: LostDealReason[]; reviewRequired: boolean } {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  if (value.length > 2) throw new Error(`${label}最多只能有 2 个结果`);
  let reviewRequired = false;
  const items = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${label}条目格式无效`);
    }
    const source = item as Record<string, unknown>;
    const knowledgeItemId = asString(source.knowledgeItemId);
    const candidate = knowledgeItemId ? allowed.get(knowledgeItemId) : undefined;
    const legacyName = asString(source.name);
    const legacyCandidate = !candidate && legacyName
      ? [...allowed.values()].find((item) => item.name === legacyName)
      : undefined;
    const selected = candidate ?? legacyCandidate;
    const name = selected?.name ?? legacyName;
    const evidence = asString(source.evidence);
    const confidence = Number(source.confidence);
    if (knowledgeItemId && !selected) {
      throw new Error(`${label}包含知识库外条目 ID：${knowledgeItemId || name}`);
    }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`${label}置信度必须在 0 到 1 之间`);
    }
    if (!selected && name !== REVIEW_NAME) {
      reviewRequired = true;
      return { name: REVIEW_NAME, proposedName: name.slice(0, 100), evidence, confidence };
    }
    if (!name || !evidence || !isGrounded(evidence) || confidence < MIN_CONFIDENCE) {
      reviewRequired = true;
      return { knowledgeItemId: selected?.id, name: REVIEW_NAME, evidence, confidence };
    }
    return { knowledgeItemId: selected?.id, name, evidence, confidence };
  });
  return { items, reviewRequired };
}

function parseDemandList(
  value: unknown,
  allowed: Set<string>,
  isGrounded: (evidence: string) => boolean,
): { items: LostDealReason[]; reviewRequired: boolean } {
  if (!Array.isArray(value)) throw new Error("需求类型必须是数组");
  if (value.length > 2) throw new Error("需求类型最多只能有 2 个结果");
  let reviewRequired = false;
  const items = value.map((item) => {
    if (typeof item === "string") {
      reviewRequired = true;
      return {
        name: REVIEW_NAME,
        proposedName: asString(item).slice(0, 100),
        evidence: "",
        confidence: 0,
      };
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("需求类型条目格式无效");
    }
    const source = item as Record<string, unknown>;
    const name = asString(source.name);
    const evidence = asString(source.evidence);
    const confidence = Number(source.confidence);
    if (name && name !== REVIEW_NAME && !allowed.has(name)) {
      throw new Error(`需求类型包含知识库外名称：${name}`);
    }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      reviewRequired = true;
      return {
        name: REVIEW_NAME,
        proposedName: name.slice(0, 100),
        evidence,
        confidence: 0,
      };
    }
    if (!name || !evidence || !isGrounded(evidence) || confidence < MIN_CONFIDENCE) {
      reviewRequired = true;
      return { name: REVIEW_NAME, proposedName: name.slice(0, 100), evidence, confidence };
    }
    return { name, evidence, confidence };
  });
  return { items, reviewRequired };
}

function parseJson(raw: string): Record<string, unknown> {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("未成交归因返回不是合法 JSON");
  }
}

export function parseLostDealAttribution(
  raw: string,
  candidates: LostDealKnowledgeCandidates,
  context?: { summary: string; sourceFields: Record<string, string> },
): LostDealAttribution {
  const parsed = parseJson(raw);
  const sources = context
    ? [context.summary, ...Object.values(context.sourceFields)].map((value) => value.replace(/\s+/g, ""))
    : [];
  const isGrounded = (evidence: string) => !context
    || sources.some((source) => source.includes(evidence.replace(/\s+/g, "")));
  const customer = parseReasonList(
    parsed.customerReasons,
    new Map(candidates.customerReasons.map((item) => [item.id, item])),
    "客户原因",
    isGrounded,
  );
  const service = parseReasonList(
    parsed.serviceReasons,
    new Map(candidates.serviceReasons.map((item) => [item.id, item])),
    "客服原因",
    isGrounded,
  );
  const demand = parseDemandList(parsed.demandTypes, new Set(candidates.demandTypes), isGrounded);
  const specificDemand = asString(parsed.specificDemand);
  const specificDemandEvidence = asString(parsed.specificDemandEvidence);
  const evidence = Array.isArray(parsed.evidence)
    ? parsed.evidence.map(asString).filter(Boolean)
    : [];
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("归因置信度必须在 0 到 1 之间");
  }
  const reviewRequired = customer.reviewRequired || service.reviewRequired || demand.reviewRequired
    || (!customer.items.length && !service.items.length)
    || (Boolean(specificDemand) && (!specificDemandEvidence || !isGrounded(specificDemandEvidence)))
    || confidence < MIN_CONFIDENCE || (Boolean(context) && (!evidence.length || evidence.some((item) => !isGrounded(item))));
  return {
    customerReasons: customer.items,
    serviceReasons: service.items,
    demandTypes: demand.items,
    specificDemand,
    specificDemandEvidence,
    specificDemandGrounded: !context || !specificDemand || Boolean(specificDemandEvidence && isGrounded(specificDemandEvidence)),
    evidence,
    confidence,
    reviewRequired,
  };
}

export function deriveLostDealFields(attribution: LostDealAttribution): Record<string, unknown> {
  const names = (items: LostDealReason[]) => items.map((item) => item.name).filter(Boolean).join("\n");
  return {
    客户原因: names(attribution.customerReasons),
    客服原因: names(attribution.serviceReasons),
    客户产品需求: attribution.specificDemandGrounded === false ? "" : attribution.specificDemand,
    未成交归因: attribution,
  };
}

function enabledKnowledgeNames(
  sectionId: string,
  baseName: string,
  valueColumn: string,
): LostDealKnowledgeCandidate[] {
  const rows = db.prepare(`
    SELECT i.id, i.values_json
    FROM knowledge_items i
    JOIN knowledge_bases b ON b.id = i.knowledge_base_id
    WHERE b.section_id = ? AND b.name = ? AND b.is_enabled = 1 AND i.is_enabled = 1
    ORDER BY i.source_row_number, i.id
  `).all(sectionId, baseName) as Array<{ id: string; values_json: string }>;
  return rows.map((row) => {
    const values = JSON.parse(row.values_json || "{}") as Record<string, unknown>;
    return {
      id: row.id,
      name: asString(values[valueColumn]),
      definition: asString(values["定义"]),
      applicable: asString(values["适用条件"]),
      excluded: asString(values["排除条件"]),
    };
  }).filter((item) => item.name);
}

export function loadLostDealKnowledgeCandidates(field: AnalysisField): LostDealKnowledgeCandidates {
  return {
    customerReasons: enabledKnowledgeNames(field.sectionId, LOST_DEAL_CUSTOMER_BASE_NAME, "原因名称"),
    serviceReasons: enabledKnowledgeNames(field.sectionId, LOST_DEAL_SERVICE_BASE_NAME, "问题名称"),
    demandTypes: field.options?.map((item) => item.trim()).filter(Boolean) ?? [],
  };
}

export function buildLostDealAttributionMessages(input: {
  field: AnalysisField;
  summary: string;
  sourceFields: Record<string, string>;
  candidates: LostDealKnowledgeCandidates;
}) {
  const text = [
    `解析板块：未成交分析`,
    "任务：仅依据截图内容总结和来源字段，统一完成未成交归因。",
    `字段说明：${input.field.prompt}`,
    `截图内容总结：${input.summary}`,
    `来源字段：${JSON.stringify(input.sourceFields)}`,
    `客户原因候选：${JSON.stringify(input.candidates.customerReasons)}`,
    `客服原因候选：${JSON.stringify(input.candidates.serviceReasons)}`,
    `客户需求类型候选：${JSON.stringify(input.candidates.demandTypes)}`,
    "每类最多选择 2 个；customerReasons、serviceReasons、demandTypes 都必须是对象数组，禁止返回字符串数组。优先使用候选知识条目 ID。若明确事实不能归入候选，可不填 ID 并提供简短的新名称和连续原文证据，系统仅标记人工复核，不自动加入知识库。不得猜测或包含个人信息。",
    "specificDemand 非空时，specificDemandEvidence 必须填写能够直接支持该需求的连续原文；找不到原文时 specificDemand 必须留空。",
    '只返回 JSON：{"customerReasons":[{"knowledgeItemId":"","name":"","evidence":"","confidence":0}],"serviceReasons":[],"demandTypes":[],"specificDemand":"","specificDemandEvidence":"","evidence":[],"confidence":0}',
  ].join("\n");
  return [
    { role: "system", content: "你是结构化客服归因助手，只返回合法 JSON，不输出解释。" },
    { role: "user", content: text },
  ];
}
