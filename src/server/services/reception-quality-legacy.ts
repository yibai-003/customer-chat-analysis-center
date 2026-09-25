import type { AnalysisField } from "../../shared/types";
import {
  receptionBusinessRules,
  type ReceptionBusinessRules,
} from "./section-business-rules";
import { receptionAiSourceFields } from "./reception-quality-rules";
import type {
  ReceptionIssue,
  ReceptionQualityAnalysis,
  ReceptionScene,
} from "./reception-quality";

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseJson(raw: string) {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("统一质检返回不是合法 JSON");
  }
}

function stringList(value: unknown, label: string, max = 30) {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  return [...new Set(value.map(asString).filter(Boolean))].slice(0, max);
}

function legacyIssueList(
  value: unknown,
  label: string,
  scope: "preSale" | "afterSale",
  rules: ReceptionBusinessRules["issues"],
) {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  if (value.length > 20) throw new Error(`${label}最多只能有 20 个问题`);
  const seen = new Set<string>();
  return value.map((entry): ReceptionIssue => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label}条目格式无效`);
    }
    const source = entry as Record<string, unknown>;
    const issueId = asString(source.issueId);
    const legacyName = asString(source.name);
    const rule = (issueId ? rules.find((item) => item.id === issueId) : undefined)
      ?? (legacyName ? rules.find((item) => item.name === legacyName) : undefined);
    if (!rule || rule.scope !== scope) {
      throw new Error(`${label}包含未知或不适用的问题ID：${issueId || legacyName || "空"}`);
    }
    const evidence = asString(source.evidence);
    const reason = asString(source.reason);
    if (!evidence || !reason) throw new Error(`${label}必须包含问题名、证据和理由`);
    if (seen.has(rule.id)) throw new Error(`${label}包含重复问题：${rule.name}`);
    seen.add(rule.id);
    const evidenceIds = Array.isArray(source.evidenceIds)
      ? [...new Set(source.evidenceIds.map(asString).filter(Boolean))].slice(0, 20)
      : [];
    return {
      issueId: rule.id,
      name: rule.name,
      dimension: rule.dimension,
      chatQuotes: [evidence],
      evidenceIds,
      evidenceExplanation: evidence,
      reason,
      deduction: rule.deduction,
      forceD: rule.forceD,
      violationCount: rule.violationCount,
      suggestion: rule.suggestion,
    };
  });
}

function calculateGrade(score: number, forceD: boolean, rules: ReceptionBusinessRules) {
  if (forceD) return rules.forceDGrade;
  let selected: ReceptionBusinessRules["gradeThresholds"][number] | undefined;
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

export function parseLegacyReceptionQuality(
  raw: string,
  fieldKey: string,
  options: { screenshotFacts?: unknown; businessRules?: Record<string, unknown> },
): ReceptionQualityAnalysis {
  const businessRules = receptionBusinessRules(options.businessRules);
  const parsed = parseJson(raw);
  const source = parsed[fieldKey] && typeof parsed[fieldKey] === "object" && !Array.isArray(parsed[fieldKey])
    ? parsed[fieldKey] as Record<string, unknown>
    : parsed;
  const scene = asString(source.scene) as ReceptionScene;
  if (!["售前", "售后", "混合", "无法判断"].includes(scene)) throw new Error("会话场景无效");
  const preSaleIssues = legacyIssueList(source.preSaleIssues, "售前问题", "preSale", businessRules.issues);
  const afterSaleIssues = legacyIssueList(source.afterSaleIssues, "售后问题", "afterSale", businessRules.issues);
  const unverifiableItems = source.blockingUnverifiableItems !== undefined
    ? stringList(source.blockingUnverifiableItems, "阻塞核验项")
    : source.unverifiableItems !== undefined
      ? stringList(source.unverifiableItems, "无法核验项")
      : [];
  const checkedRuleIds = source.checkedRuleIds !== undefined
    ? stringList(source.checkedRuleIds, "已检查规则", businessRules.issues.length)
    : [];
  if (source.checkedRuleIds !== undefined) {
    const checked = new Set(checkedRuleIds.filter((id) =>
      businessRules.issues.some((rule) => rule.id === id)));
    const missing = expectedRuleIds(scene, businessRules.issues).filter((id) => !checked.has(id));
    if (missing.length) unverifiableItems.push(`规则覆盖不完整：缺少 ${missing.length} 项`);
  }
  const informationalUnverifiableItems = source.informationalUnverifiableItems !== undefined
    ? stringList(source.informationalUnverifiableItems, "提示性核验项")
    : [];
  const confidence = Number(source.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("质检置信度必须在 0 到 1 之间");
  }
  const issues: ReceptionIssue[] = [];
  for (const issue of [...preSaleIssues, ...afterSaleIssues]) {
    const priority = businessRules.issues.find((rule) => rule.id === issue.issueId)!.priority;
    const index = issues.findIndex((existing) =>
      businessRules.issues.find((rule) => rule.id === existing.issueId)!.priority > priority);
    if (index < 0) issues.push(issue);
    else issues.splice(index, 0, issue);
  }
  const totalDeduction = [...new Map(preSaleIssues.map((issue) => [issue.name, issue.deduction])).values()]
    .reduce((sum, deduction) => sum + deduction, 0);
  const score = Math.max(0, businessRules.scoreBase - totalDeduction);
  const hasDLevelIssue = preSaleIssues.some((issue) => issue.forceD);
  const sceneMismatch = (scene === "售前" && afterSaleIssues.length > 0)
    || (scene === "售后" && preSaleIssues.length > 0);
  return {
    analysisProtocol: "legacy",
    scene,
    checkedRuleIds,
    preSaleIssues,
    afterSaleIssues,
    unverifiableItems,
    informationalUnverifiableItems,
    suggestion: issues.length
      ? [...new Set(issues.slice(0, 3).map((issue) => issue.suggestion))].join("；")
      : "保持当前服务规范",
    confidence,
    score,
    totalDeduction,
    grade: calculateGrade(score, hasDLevelIssue, businessRules),
    hasDLevelIssue,
    hasAfterSaleViolation: afterSaleIssues.length > 0,
    labels: issues.map((issue) => issue.name).slice(0, 3),
    dimensions: issues.map((issue) => issue.dimension).slice(0, 3),
    deductions: issues.map((issue) => issue.deduction).slice(0, 3),
    conversationStartTime: "",
    conversationRoundCount: 0,
    reviewRequired: scene === "无法判断"
      || confidence < 0.5
      || unverifiableItems.length > 0
      || sceneMismatch,
  };
}

function legacyScopes(screenshotFacts: unknown): Array<"preSale" | "afterSale"> {
  if (!screenshotFacts || typeof screenshotFacts !== "object" || Array.isArray(screenshotFacts)) {
    return ["preSale", "afterSale"];
  }
  const source = screenshotFacts as Record<string, unknown>;
  const hints = Array.isArray(source.sceneHints)
    ? source.sceneHints.map(asString)
    : [asString(source["会话场景"])];
  const hasPreSale = hints.includes("售前");
  const hasAfterSale = hints.includes("售后");
  if (hasPreSale && !hasAfterSale) return ["preSale"];
  if (hasAfterSale && !hasPreSale) return ["afterSale"];
  return ["preSale", "afterSale"];
}

export function buildLegacyReceptionQualityMessages(input: {
  field: AnalysisField;
  screenshotFacts: unknown;
  sourceFields: Record<string, string>;
  businessRules?: Record<string, unknown>;
}) {
  const rules = receptionBusinessRules(input.businessRules).issues;
  const protocol = {
    scene: "售前|售后|混合|无法判断",
    checkedRuleIds: ["本次场景内已经逐项检查的全部问题ID"],
    preSaleIssues: [{
      issueId: "PRE_ANSWER_IRRELEVANT",
      evidenceIds: ["T2"],
      evidence: "最小必要原文",
      reason: "触发规则的具体理由",
    }],
    afterSaleIssues: [],
    blockingUnverifiableItems: [],
    informationalUnverifiableItems: [],
    confidence: 0.8,
  };
  const text = [
    "解析板块：接待流程质检",
    "任务：对同一会话统一完成售前和售后质检，只列有明确证据支持的违规项。",
    ...(input.field.prompt.trim().length > 0 && input.field.prompt.trim().length <= 1000
      ? [`补充要求：${input.field.prompt.trim()}`]
      : []),
    "可选问题目录（只能使用其中的 issueId）：",
    rules.filter((rule) => legacyScopes(input.screenshotFacts).includes(rule.scope))
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
    `统一截图事实：${JSON.stringify(input.screenshotFacts)}`,
    `辅助字段：${JSON.stringify(receptionAiSourceFields(input.sourceFields))}`,
    "不要输出问题名称、分数、等级、违规次数、标签或建议，这些结果由程序生成。",
    `只返回合法 JSON，格式：${JSON.stringify(protocol)}`,
  ].join("\n");
  return [
    {
      role: "system",
      content: "你是客服接待流程质检助手。原文至上，严格区分客户、客服、机器人和系统消息，只返回合法 JSON。",
    },
    { role: "user", content: [{ type: "text", text }] },
  ];
}
