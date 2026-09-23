import { z } from "zod";
import type {
  AnalysisField,
  SectionConfigVersion,
} from "../../shared/types";
import { alignReceptionIssueValues } from "../../shared/reception-quality-results";
import { receptionAiSourceFields } from "./reception-quality-rules";
import { receptionBusinessRules, type ReceptionBusinessRules } from "./section-business-rules";

export type ReceptionScene = "售前" | "售后" | "混合" | "无法判断";
export type ReceptionSpeaker = "客户" | "客服" | "机器人" | "系统" | "无法判断";

export interface ReceptionDialogueTurn {
  id: string;
  speaker: ReceptionSpeaker;
  time: string;
  text: string;
}

export interface ReceptionScreenshotFacts {
  sceneHints: Array<"售前" | "售后" | "无法判断">;
  dialogueTurns: ReceptionDialogueTurn[];
  customerIntents: string[];
  serviceActions: string[];
  businessFacts: string[];
  missingSignals: string[];
  conversationStartTime: string;
  conversationRoundCount: number;
  reviewReasons: string[];
}

export interface ReceptionIssue {
  issueId: string;
  name: string;
  dimension: string;
  chatQuotes: string[];
  evidenceIds: string[];
  evidenceExplanation: string;
  reason: string;
  deduction: number;
  forceD: boolean;
  violationCount: number;
  suggestion: string;
}

export interface ReceptionQualityAnalysis {
  analysisProtocol: "legacy" | "strict";
  scene: ReceptionScene;
  checkedRuleIds: string[];
  preSaleIssues: ReceptionIssue[];
  afterSaleIssues: ReceptionIssue[];
  unverifiableItems: string[];
  informationalUnverifiableItems: string[];
  suggestion: string;
  confidence: number;
  score: number;
  totalDeduction: number;
  grade: "A" | "B" | "C" | "D";
  hasDLevelIssue: boolean;
  hasAfterSaleViolation: boolean;
  labels: string[];
  dimensions: string[];
  deductions: number[];
  conversationStartTime: string;
  conversationRoundCount: number;
  reviewRequired: boolean;
}

const shortText = z.string().trim().min(1).max(20_000);
const optionalText = z.string().trim().max(20_000);
const stringArray = z.array(shortText).max(100);

const screenshotFactsSchema = z.object({
  sceneHints: z.array(z.enum(["售前", "售后", "无法判断"])).max(3),
  dialogueTurns: z.array(z.object({
    id: z.string().trim().min(1).max(40),
    speaker: z.enum(["客户", "客服", "机器人", "系统", "无法判断"]),
    time: optionalText,
    text: shortText,
  }).strict()).max(500),
  customerIntents: stringArray,
  serviceActions: stringArray,
  businessFacts: stringArray,
  missingSignals: stringArray,
}).strict();

const qualityIssueSchema = z.object({
  issueId: z.string().trim().min(1).max(120),
  evidenceIds: z.array(z.string().trim().min(1).max(40)).min(1).max(30),
  chatQuotes: z.array(shortText).min(1).max(30),
  evidenceExplanation: shortText,
  reason: shortText,
}).strict();

const qualityResponseSchema = z.object({
  scene: z.enum(["售前", "售后", "混合", "无法判断"]),
  checkedRuleIds: z.array(z.string().trim().min(1).max(120)).max(200),
  preSaleIssues: z.array(qualityIssueSchema).max(50),
  afterSaleIssues: z.array(qualityIssueSchema).max(50),
  blockingUnverifiableItems: stringArray,
  informationalUnverifiableItems: stringArray,
  confidence: z.number().min(0).max(1),
}).strict();

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label}返回不是合法 JSON`);
  }
}

function schemaError(label: string, error: z.ZodError) {
  return new Error(`${label}结构不符合 Schema：${error.issues.slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "root"} ${issue.message}`)
    .join("；")}`);
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function parseExplicitDateTime(value: string): { timestamp: number; value: string } | undefined {
  const match = value.match(
    /(\d{4})\s*(?:年|[-/])\s*(\d{1,2})\s*(?:月|[-/])\s*(\d{1,2})\s*(?:日)?[T\s]+(\d{1,2})\s*(?::|时)\s*(\d{1,2})(?:\s*(?::|分)\s*(\d{1,2}))?/,
  );
  if (!match) return;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "0"] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second) return;
  return {
    timestamp: date.getTime(),
    value: match[0].trim(),
  };
}

export function countReceptionConversationRounds(turns: ReceptionDialogueTurn[]) {
  let waitingForAgent = false;
  let rounds = 0;
  for (const turn of turns) {
    if (turn.speaker === "客户") {
      waitingForAgent = true;
    } else if (turn.speaker === "客服" && waitingForAgent) {
      rounds++;
      waitingForAgent = false;
    }
  }
  return rounds;
}

export function deriveReceptionConversationFacts(
  facts: Omit<ReceptionScreenshotFacts, "conversationStartTime" | "conversationRoundCount" | "reviewReasons">,
  excelStartTime = "",
): ReceptionScreenshotFacts {
  const excelDateTime = parseExplicitDateTime(excelStartTime);
  const chatDateTime = facts.dialogueTurns.reduce<
    { timestamp: number; value: string } | undefined
  >((earliest, turn) => {
    const current = parseExplicitDateTime(turn.time);
    return current && (!earliest || current.timestamp < earliest.timestamp)
      ? current
      : earliest;
  }, undefined);
  const conversationStartTime = excelDateTime
    ? excelStartTime.trim()
    : chatDateTime?.value ?? "";
  const reviewReasons = conversationStartTime
    ? []
    : ["会话开始时间：Excel 和聊天记录均无法可靠识别完整日期和时间"];
  return {
    ...facts,
    conversationStartTime,
    conversationRoundCount: countReceptionConversationRounds(facts.dialogueTurns),
    reviewReasons,
  };
}

export function parseReceptionScreenshotFacts(
  raw: string,
  fieldKey = "截图内容总结",
  sourceFields: Record<string, string> = {},
) {
  const parsed = parseJsonObject(raw, "截图事实抽取");
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== fieldKey) {
    throw new Error(`截图事实抽取结构不符合 Schema：根对象只能包含 ${fieldKey}`);
  }
  const checked = screenshotFactsSchema.safeParse(parsed[fieldKey]);
  if (!checked.success) throw schemaError("截图事实抽取", checked.error);
  const dialogueIds = checked.data.dialogueTurns.map((turn) => turn.id);
  if (new Set(dialogueIds).size !== dialogueIds.length) {
    throw new Error("截图事实抽取结构不符合 Schema：对话编号重复");
  }
  const excelStartTime = Object.entries(sourceFields).find(([key]) =>
    key.trim() === "会话开始时间"
    || key.trim() === "会话开始时间 (conversation_started_at)"
    || key.trim() === "会话开始时间（conversation_started_at)"
    || /^\s*会话开始时间\s*[（(]\s*conversation_started_at\s*[)）]\s*$/.test(key))?.[1] ?? "";
  return deriveReceptionConversationFacts({
    ...checked.data,
    sceneHints: unique(checked.data.sceneHints) as ReceptionScreenshotFacts["sceneHints"],
    customerIntents: unique(checked.data.customerIntents),
    serviceActions: unique(checked.data.serviceActions),
    businessFacts: unique(checked.data.businessFacts),
    missingSignals: unique(checked.data.missingSignals),
  }, excelStartTime);
}

export function buildReceptionScreenshotFactsMessages(input: {
  field: AnalysisField;
  sourceFields: Record<string, string>;
  imageDataUrl: string;
}) {
  const protocol = {
    [input.field.key]: {
      sceneHints: ["售前"],
      dialogueTurns: [{
        id: "T1",
        speaker: "客户|客服|机器人|系统|无法判断",
        time: "截图原文时间；无法识别时为空字符串",
        text: "原文",
      }],
      customerIntents: ["客户明确诉求"],
      serviceActions: ["人工客服明确执行的动作"],
      businessFacts: ["截图中的明确业务事实"],
      missingSignals: ["无法从截图可靠确认的信息"],
    },
  };
  const text = [
    "解析板块：接待流程质检",
    "任务：只执行一次客观截图事实抽取，不作质检判断。",
    `版本字段提示词：${input.field.prompt}`,
    `辅助字段：${JSON.stringify(receptionAiSourceFields(input.sourceFields))}`,
    "必须区分客户、人工客服、机器人和系统消息；机器人和系统消息不得标记为客服。",
    "time 只能抄录截图中可见的时间原文，不得用业务日期、导入时间或上下文推算。",
    "禁止输出问题 ID、维度、扣分、等级、建议或其他质检结论。",
    `只返回严格 JSON，不得增加字段：${JSON.stringify(protocol)}`,
  ].join("\n");
  return [
    {
      role: "system",
      content: "你是客服聊天截图事实抽取助手。只抄录可见事实，只返回符合指定 Schema 的合法 JSON。",
    },
    {
      role: "user",
      content: [
        { type: "text", text },
        ...(input.imageDataUrl
          ? [{ type: "image_url", image_url: { url: input.imageDataUrl } }]
          : []),
      ],
    },
  ];
}

function calculateGrade(
  score: number,
  forceD: boolean,
  rules: ReceptionBusinessRules,
): "A" | "B" | "C" | "D" {
  if (forceD) return rules.forceDGrade;
  let selected: { grade: "A" | "B" | "C" | "D"; minScore: number } | undefined;
  for (const threshold of rules.gradeThresholds) {
    if (score >= threshold.minScore && (!selected || threshold.minScore > selected.minScore)) {
      selected = threshold;
    }
  }
  return selected?.grade ?? "D";
}

function expectedRuleIds(scene: ReceptionScene, rules: ReceptionBusinessRules["issues"]) {
  return rules
    .filter((rule) => scene === "混合"
      || scene === "无法判断"
      || (scene === "售前" ? rule.scope === "preSale" : rule.scope === "afterSale"))
    .map((rule) => rule.id);
}

function promptedScopes(screenshotFacts: unknown): Array<"preSale" | "afterSale"> {
  if (!screenshotFacts || typeof screenshotFacts !== "object" || Array.isArray(screenshotFacts)) {
    return ["preSale", "afterSale"];
  }
  const source = screenshotFacts as Partial<ReceptionScreenshotFacts>;
  const hints = Array.isArray(source.sceneHints) ? source.sceneHints : [];
  const hasPreSale = hints.includes("售前");
  const hasAfterSale = hints.includes("售后");
  if (hasPreSale && !hasAfterSale) return ["preSale"];
  if (hasAfterSale && !hasPreSale) return ["afterSale"];
  return ["preSale", "afterSale"];
}

function screenshotFactsValue(value: unknown): Partial<ReceptionScreenshotFacts> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<ReceptionScreenshotFacts>
    : {};
}

function parseIssueList(
  entries: z.infer<typeof qualityIssueSchema>[],
  label: string,
  scope: "preSale" | "afterSale",
  rules: ReceptionBusinessRules["issues"],
  seen: Set<string>,
): ReceptionIssue[] {
  return entries.map((entry) => {
    const rule = rules.find((item) => item.id === entry.issueId);
    if (!rule) throw new Error(`${label}包含目录外问题 ID：${entry.issueId}`);
    if (rule.scope !== scope) throw new Error(`${label}包含不适用的问题 ID：${entry.issueId}`);
    if (seen.has(rule.id)) throw new Error(`模型返回重复问题 ID：${rule.id}`);
    seen.add(rule.id);
    return {
      issueId: rule.id,
      name: rule.name,
      dimension: rule.dimension,
      chatQuotes: entry.chatQuotes,
      evidenceIds: unique(entry.evidenceIds),
      evidenceExplanation: entry.evidenceExplanation,
      reason: entry.reason,
      deduction: rule.deduction,
      forceD: rule.forceD,
      violationCount: rule.violationCount,
      suggestion: rule.suggestion,
    };
  });
}

function traceableIssues(
  issues: ReceptionIssue[],
  screenshotFacts: Partial<ReceptionScreenshotFacts>,
  unverifiableItems: string[],
) {
  const turns = Array.isArray(screenshotFacts.dialogueTurns)
    ? screenshotFacts.dialogueTurns
    : [];
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  return issues.filter((issue) => {
    const referenced = issue.evidenceIds.map((id) => byId.get(id));
    if (referenced.some((turn) => !turn)) {
      unverifiableItems.push(`${issue.name}：证据编号无法回溯到截图事实`);
      return false;
    }
    const texts = referenced.flatMap((turn) => turn ? [turn.text.trim()] : []);
    const quotesMatch = issue.chatQuotes.every((quote) =>
      texts.some((text) => text.includes(quote) || quote.includes(text)));
    if (!quotesMatch) {
      unverifiableItems.push(`${issue.name}：相关聊天原文无法回溯到证据编号`);
      return false;
    }
    return true;
  });
}

export function parseReceptionQuality(
  raw: string,
  options: { screenshotFacts?: unknown; businessRules?: Record<string, unknown> } = {},
): ReceptionQualityAnalysis {
  const businessRules = receptionBusinessRules(options.businessRules);
  const parsed = parseJsonObject(raw, "统一质检");
  const checked = qualityResponseSchema.safeParse(parsed);
  if (!checked.success) throw schemaError("统一质检", checked.error);

  const rules = businessRules.issues;
  const knownRuleIds = new Set(rules.map((rule) => rule.id));
  const expectedIds = expectedRuleIds(checked.data.scene, rules);
  const expectedSet = new Set(expectedIds);
  const checkedRuleIds = unique(checked.data.checkedRuleIds);
  const unknownChecked = checkedRuleIds.find((id) => !knownRuleIds.has(id));
  if (unknownChecked) throw new Error(`已检查规则包含目录外问题 ID：${unknownChecked}`);
  const inapplicableChecked = checkedRuleIds.find((id) => !expectedSet.has(id));
  if (inapplicableChecked) throw new Error(`已检查规则包含当前场景不适用的问题 ID：${inapplicableChecked}`);

  const seen = new Set<string>();
  let preSaleIssues = parseIssueList(checked.data.preSaleIssues, "售前问题", "preSale", rules, seen);
  let afterSaleIssues = parseIssueList(checked.data.afterSaleIssues, "售后问题", "afterSale", rules, seen);
  const facts = screenshotFactsValue(options.screenshotFacts);
  const unverifiableItems = unique([
    ...checked.data.blockingUnverifiableItems,
    ...(Array.isArray(facts.reviewReasons) ? facts.reviewReasons : []),
  ]);
  const missingCoverage = expectedIds.filter((id) => !checkedRuleIds.includes(id));
  if (missingCoverage.length) {
    unverifiableItems.push(`规则覆盖不完整：缺少 ${missingCoverage.length} 项`);
  }
  preSaleIssues = traceableIssues(preSaleIssues, facts, unverifiableItems);
  afterSaleIssues = traceableIssues(afterSaleIssues, facts, unverifiableItems);

  const sceneMismatch = (checked.data.scene === "售前" && afterSaleIssues.length > 0)
    || (checked.data.scene === "售后" && preSaleIssues.length > 0);
  if (sceneMismatch) unverifiableItems.push("模型返回了与会话场景不一致的问题");

  const issues: ReceptionIssue[] = [];
  for (const issue of [...preSaleIssues, ...afterSaleIssues]) {
    const priority = rules.find((rule) => rule.id === issue.issueId)!.priority;
    const index = issues.findIndex((existing) =>
      rules.find((rule) => rule.id === existing.issueId)!.priority > priority);
    if (index < 0) issues.push(issue);
    else issues.splice(index, 0, issue);
  }
  const totalDeduction = issues.reduce((sum, issue) => sum + issue.deduction, 0);
  const score = Math.max(0, businessRules.scoreBase - totalDeduction);
  const hasDLevelIssue = issues.some((issue) => issue.forceD);
  const grade = calculateGrade(score, hasDLevelIssue, businessRules);
  return {
    analysisProtocol: "strict",
    scene: checked.data.scene,
    checkedRuleIds,
    preSaleIssues,
    afterSaleIssues,
    unverifiableItems: unique(unverifiableItems),
    informationalUnverifiableItems: unique(checked.data.informationalUnverifiableItems),
    suggestion: unique(issues.map((issue) => issue.suggestion)).join("；"),
    confidence: checked.data.confidence,
    score,
    totalDeduction,
    grade,
    hasDLevelIssue,
    hasAfterSaleViolation: afterSaleIssues.length > 0,
    labels: issues.map((issue) => issue.name),
    dimensions: issues.map((issue) => issue.dimension),
    deductions: issues.map((issue) => issue.deduction),
    conversationStartTime: typeof facts.conversationStartTime === "string"
      ? facts.conversationStartTime
      : "",
    conversationRoundCount: typeof facts.conversationRoundCount === "number"
      ? facts.conversationRoundCount
      : 0,
    reviewRequired: checked.data.scene === "无法判断"
      || checked.data.confidence < 0.5
      || unverifiableItems.length > 0
      || sceneMismatch,
  };
}

function issueReport(issues: ReceptionIssue[]) {
  if (!issues.length) return "";
  return issues.map((issue, index) => [
    `${index + 1}. ${issue.name}`,
    `相关原文：${issue.chatQuotes.join("；")}`,
    `证据说明：${issue.evidenceExplanation}`,
    `判定理由：${issue.reason}`,
  ].join("\n")).join("\n\n");
}

export function deriveReceptionQualityFields(quality: ReceptionQualityAnalysis): Record<string, unknown> {
  const aligned = alignReceptionIssueValues(quality);
  const needsReview = quality.reviewRequired || aligned.hasMismatch;
  return {
    "问题点-售前": issueReport(quality.preSaleIssues)
      || (quality.analysisProtocol === "legacy" ? "未发现有明确原文证据支持的售前违规项。" : ""),
    "问题点-售后": issueReport(quality.afterSaleIssues)
      || (quality.analysisProtocol === "legacy" ? "未发现有明确原文或辅助数据支持的售后违规项。" : ""),
    "有无违规-售后": quality.hasAfterSaleViolation ? "有违规" : "无违规",
    "客服问题识别问题并打标签": aligned.labels.join("/"),
    "接待流程质检结果": quality.grade,
    "优化建议-售前": quality.suggestion
      || (quality.analysisProtocol === "legacy" ? "保持当前服务规范" : ""),
    "会话开始时间": quality.conversationStartTime,
    "会话ID": "",
    "对话轮数": quality.conversationRoundCount,
    "等级": quality.grade,
    "合计扣分": quality.totalDeduction,
    "优化建议": quality.suggestion,
    "是否待人工复核": needsReview ? "是" : "否",
    "维度": aligned.dimensions.join("/"),
    "问题": aligned.labels.join("/"),
    "扣分": aligned.deductions.join("/"),
    "是否D级": aligned.labels.length ? quality.hasDLevelIssue ? "是" : "否" : "",
    "聊天原文": aligned.chatQuotes.join("/"),
    "证据说明": aligned.evidenceExplanations.join("/"),
    "判定理由": aligned.reasons.join("/"),
  };
}

export function receptionKnowledgeSnapshotContext(
  snapshot: SectionConfigVersion["knowledgeSnapshot"] = [],
) {
  const bases = snapshot.flatMap((base) => {
    if (!base || typeof base !== "object" || base.isEnabled === false) return [];
    const items = Array.isArray(base.items)
      ? base.items.flatMap((item) => {
        if (!item || typeof item !== "object" || item.isEnabled === false) return [];
        return item.values && typeof item.values === "object"
          ? [item.values]
          : [];
      })
      : [];
    return items.length
      ? [{ name: String(base.name ?? ""), items }]
      : [];
  });
  const serialized = JSON.stringify(bases);
  return serialized.length <= 20_000
    ? serialized
    : `${serialized.slice(0, 20_000)}…（版本知识快照内容已按提示词上限截断）`;
}

export function buildReceptionQualityMessages(input: {
  field: AnalysisField;
  screenshotFacts: unknown;
  sourceFields: Record<string, string>;
  businessRules?: Record<string, unknown>;
  knowledgeSnapshot?: SectionConfigVersion["knowledgeSnapshot"];
}) {
  const rules = receptionBusinessRules(input.businessRules).issues;
  const protocol = {
    scene: "售前|售后|混合|无法判断",
    checkedRuleIds: ["本次场景内已经逐项检查的全部问题 ID"],
    preSaleIssues: [{
      issueId: "PRE_ANSWER_IRRELEVANT",
      evidenceIds: ["T2"],
      chatQuotes: ["与问题直接相关的聊天原文"],
      evidenceExplanation: "原文如何满足规则证据要求",
      reason: "命中适用条件和触发条件且未命中排除条件的理由",
    }],
    afterSaleIssues: [],
    blockingUnverifiableItems: ["仅列会改变结论且必须人工确认的缺失信息"],
    informationalUnverifiableItems: ["不影响当前结论的缺失信息"],
    confidence: 0.8,
  };
  const text = [
    "解析板块：接待流程质检",
    "任务：基于一次截图事实抽取，对同一会话统一完成售前和售后质检。",
    `版本字段提示词：${input.field.prompt}`,
    "版本问题目录（只能返回其中适用于当前场景的 issueId）：",
    rules.filter((rule) => promptedScopes(input.screenshotFacts).includes(rule.scope))
      .map((rule) => [
        rule.id,
        rule.name,
        rule.scope === "preSale" ? "售前" : "售后",
        `适用:${rule.applicableWhen.join("；")}`,
        `违规:${rule.triggerWhen.join("；")}`,
        `排除:${rule.exclusions.join("；") || "无"}`,
        `证据:${rule.requiredEvidence.join("；")}`,
        `缺失:${rule.missingDataOutcome}`,
      ].join("|")).join("\n"),
    `任务绑定版本知识快照：${receptionKnowledgeSnapshotContext(input.knowledgeSnapshot) || "[]"}`,
    `统一截图事实：${JSON.stringify(input.screenshotFacts)}`,
    `辅助字段：${JSON.stringify(receptionAiSourceFields(input.sourceFields))}`,
    "知识快照只用于核对明确业务事实；若参考结果示例与版本问题目录或规则冲突，以版本规则为准。",
    "必须逐项检查当前场景对应的全部规则，并把全部 ID 写入 checkedRuleIds；合规或不适用规则不得进入问题数组。",
    "每个问题必须提供 evidenceIds、相关聊天原文、证据说明和判定理由；没有可回溯证据不得输出问题。",
    "不要输出问题名称、维度、扣分、D 级、总扣分、总分、等级、标签或建议，这些结果全部由本地版本规则生成。",
    `只返回严格 JSON，不得增加字段：${JSON.stringify(protocol)}`,
  ].join("\n");
  return [
    {
      role: "system",
      content: "你是客服接待流程质检助手。原文至上，只能选择版本目录内问题，只返回符合指定 Schema 的合法 JSON。",
    },
    { role: "user", content: [{ type: "text", text }] },
  ];
}
