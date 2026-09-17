import type { AnalysisField } from "../../shared/types";
import {
  RECEPTION_ISSUE_RULES,
  RECEPTION_RULE_BY_ID,
  RECEPTION_RULE_BY_NAME,
  receptionAiSourceFields,
  receptionIssueCatalogPrompt,
} from "./reception-quality-rules";

export type ReceptionScene = "售前" | "售后" | "混合" | "无法判断";

export interface ReceptionIssue {
  issueId: string;
  name: string;
  evidence: string;
  evidenceIds: string[];
  reason: string;
  deduction: number;
  forceD: boolean;
  violationCount: number;
}

export interface ReceptionQualityAnalysis {
  scene: ReceptionScene;
  checkedRuleIds: string[];
  preSaleIssues: ReceptionIssue[];
  afterSaleIssues: ReceptionIssue[];
  unverifiableItems: string[];
  informationalUnverifiableItems: string[];
  suggestion: string;
  confidence: number;
  score: number;
  grade: "A" | "B" | "C" | "D";
  hasAfterSaleViolation: boolean;
  labels: string[];
  reviewRequired: boolean;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseJson(raw: string): Record<string, unknown> {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("统一质检返回不是合法 JSON");
  }
}

function stringList(value: unknown, label: string, max = 30): string[] {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  return [...new Set(value.map(asString).filter(Boolean))].slice(0, max);
}

function parseIssueList(value: unknown, label: string, scope: "preSale" | "afterSale"): ReceptionIssue[] {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  if (value.length > 20) throw new Error(`${label}最多只能有 20 个问题`);
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${label}条目格式无效`);
    const source = entry as Record<string, unknown>;
    const issueId = asString(source.issueId);
    const legacyName = asString(source.name);
    const rule = (issueId ? RECEPTION_RULE_BY_ID.get(issueId) : undefined)
      ?? (legacyName ? RECEPTION_RULE_BY_NAME.get(legacyName) : undefined);
    if (!rule || rule.scope !== scope) throw new Error(`${label}包含未知或不适用的问题ID：${issueId || legacyName || "空"}`);
    const evidence = asString(source.evidence);
    const evidenceIds = Array.isArray(source.evidenceIds)
      ? [...new Set(source.evidenceIds.map(asString).filter(Boolean))].slice(0, 20)
      : [];
    const reason = asString(source.reason);
    if (!evidence || !reason) throw new Error(`${label}必须包含问题名、证据和理由`);
    if (seen.has(rule.id)) throw new Error(`${label}包含重复问题：${rule.name}`);
    seen.add(rule.id);
    return {
      issueId: rule.id,
      name: rule.name,
      evidence,
      evidenceIds,
      reason,
      deduction: rule.deduction,
      forceD: rule.forceD,
      violationCount: rule.violationCount,
    };
  });
}

function calculateGrade(score: number, forceD: boolean): "A" | "B" | "C" | "D" {
  if (forceD || score < 80) return "D";
  if (score < 90) return "C";
  if (score < 95) return "B";
  return "A";
}

function dialogueEvidenceIds(screenshotFacts: unknown): Set<string> {
  if (!screenshotFacts || typeof screenshotFacts !== "object" || Array.isArray(screenshotFacts)) return new Set();
  const turns = (screenshotFacts as Record<string, unknown>).dialogueTurns;
  if (!Array.isArray(turns)) return new Set();
  return new Set(turns.flatMap((turn) => {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) return [];
    const id = asString((turn as Record<string, unknown>).id);
    return id ? [id] : [];
  }));
}

function expectedRuleIds(scene: ReceptionScene) {
  return RECEPTION_ISSUE_RULES
    .filter((rule) => scene === "混合"
      || scene === "无法判断"
      || (scene === "售前" ? rule.scope === "preSale" : rule.scope === "afterSale"))
    .map((rule) => rule.id);
}

function promptedScopes(screenshotFacts: unknown): Array<"preSale" | "afterSale"> {
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

export function parseReceptionQuality(
  raw: string,
  fieldKey = "统一质检分析",
  options: { screenshotFacts?: unknown } = {},
): ReceptionQualityAnalysis {
  const parsed = parseJson(raw);
  const source = parsed[fieldKey] && typeof parsed[fieldKey] === "object" && !Array.isArray(parsed[fieldKey])
    ? parsed[fieldKey] as Record<string, unknown>
    : parsed;
  const scene = asString(source.scene) as ReceptionScene;
  if (!["售前", "售后", "混合", "无法判断"].includes(scene)) throw new Error("会话场景无效");
  let preSaleIssues = parseIssueList(source.preSaleIssues, "售前问题", "preSale");
  let afterSaleIssues = parseIssueList(source.afterSaleIssues, "售后问题", "afterSale");
  const legacyUnverifiableItems = source.unverifiableItems;
  const unverifiableItems = source.blockingUnverifiableItems !== undefined
    ? stringList(source.blockingUnverifiableItems, "阻塞核验项")
    : legacyUnverifiableItems !== undefined
      ? stringList(legacyUnverifiableItems, "无法核验项")
      : [];
  const checkedRuleIds = source.checkedRuleIds !== undefined
    ? stringList(source.checkedRuleIds, "已检查规则", RECEPTION_ISSUE_RULES.length)
    : [];
  if (source.checkedRuleIds !== undefined) {
    const checked = new Set(checkedRuleIds.filter((id) => RECEPTION_RULE_BY_ID.has(id)));
    const missing = expectedRuleIds(scene).filter((id) => !checked.has(id));
    if (missing.length) unverifiableItems.push(`规则覆盖不完整：缺少 ${missing.length} 项`);
  }
  const validEvidenceIds = dialogueEvidenceIds(options.screenshotFacts);
  if (validEvidenceIds.size) {
    const keepTraceable = (issues: ReceptionIssue[]) => issues.filter((issue) => {
      if (!issue.evidenceIds.length || issue.evidenceIds.some((id) => validEvidenceIds.has(id))) return true;
      unverifiableItems.push(`${issue.name}：证据编号无法回溯到截图事实`);
      return false;
    });
    preSaleIssues = keepTraceable(preSaleIssues);
    afterSaleIssues = keepTraceable(afterSaleIssues);
  }
  const informationalUnverifiableItems = source.informationalUnverifiableItems !== undefined
    ? stringList(source.informationalUnverifiableItems, "提示性核验项")
    : [];
  const confidence = Number(source.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("质检置信度必须在 0 到 1 之间");

  const uniqueDeductions = new Map(preSaleIssues.map((issue) => [issue.name, issue.deduction]));
  const score = Math.max(0, 100 - [...uniqueDeductions.values()].reduce((sum, value) => sum + value, 0));
  const grade = calculateGrade(score, preSaleIssues.some((issue) => issue.forceD));
  const issues = [...preSaleIssues, ...afterSaleIssues]
    .sort((left, right) => {
      const leftRule = RECEPTION_RULE_BY_ID.get(left.issueId)!;
      const rightRule = RECEPTION_RULE_BY_ID.get(right.issueId)!;
      return leftRule.priority - rightRule.priority;
    });
  const labels = issues.map((issue) => issue.name).slice(0, 3);
  const suggestion = issues.length
    ? [...new Set(issues.slice(0, 3).map((issue) => RECEPTION_RULE_BY_ID.get(issue.issueId)!.suggestion))].join("；")
    : "保持当前服务规范";
  const sceneMismatch = (scene === "售前" && afterSaleIssues.length > 0)
    || (scene === "售后" && preSaleIssues.length > 0);
  return {
    scene,
    checkedRuleIds,
    preSaleIssues,
    afterSaleIssues,
    unverifiableItems,
    informationalUnverifiableItems,
    suggestion,
    confidence,
    score,
    grade,
    hasAfterSaleViolation: afterSaleIssues.length > 0,
    labels,
    reviewRequired: scene === "无法判断" || confidence < 0.5 || unverifiableItems.length > 0 || sceneMismatch,
  };
}

function issueReport(issues: ReceptionIssue[], emptyText: string) {
  if (!issues.length) return emptyText;
  return issues.map((issue, index) => [
    `${index + 1}. ${issue.name}`,
    `证据：${issue.evidence}`,
    `判定理由：${issue.reason}`,
  ].join("\n")).join("\n\n");
}

export function deriveReceptionQualityFields(quality: ReceptionQualityAnalysis): Record<string, string> {
  const labels = quality.labels.length
    ? quality.labels.join("、")
    : quality.unverifiableItems.length ? "待人工核验" : "无违规";
  return {
    "问题点-售前": issueReport(quality.preSaleIssues, "未发现有明确原文证据支持的售前违规项。"),
    "问题点-售后": issueReport(quality.afterSaleIssues, "未发现有明确原文或辅助数据支持的售后违规项。"),
    "有无违规-售后": quality.hasAfterSaleViolation ? "有违规" : "无违规",
    "客服问题识别问题并打标签": labels,
    "接待流程质检结果": quality.grade,
    "优化建议-售前": quality.suggestion,
  };
}

export function buildReceptionQualityMessages(input: {
  field: AnalysisField;
  screenshotFacts: unknown;
  sourceFields: Record<string, string>;
}) {
  const protocol = {
    scene: "售前|售后|混合|无法判断",
    checkedRuleIds: ["本次场景内已经逐项检查的全部问题ID"],
    preSaleIssues: [{
      issueId: "PRE_ANSWER_IRRELEVANT",
      evidenceIds: ["T2"],
      evidence: "最小必要原文",
      reason: "触发规则的具体理由",
    }],
    afterSaleIssues: [{
      issueId: "POST_NO_REPLY",
      evidenceIds: ["T5"],
      evidence: "最小必要原文或辅助数据",
      reason: "触发规则的具体理由",
    }],
    blockingUnverifiableItems: ["仅列会影响本次结论、必须人工确认的缺失信息"],
    informationalUnverifiableItems: ["列出不影响已有结论的其他缺失信息"],
    confidence: 0.8,
  };
  const text = [
    "解析板块：接待流程质检",
    "任务：对同一会话统一完成售前和售后质检，只列有明确证据支持的违规项。",
    ...(input.field.prompt.trim().length > 0 && input.field.prompt.trim().length <= 1000
      ? [`补充要求：${input.field.prompt.trim()}`]
      : []),
    "可选问题目录（只能使用其中的 issueId）：",
    receptionIssueCatalogPrompt(promptedScopes(input.screenshotFacts)),
    `统一截图事实：${JSON.stringify(input.screenshotFacts)}`,
    `辅助字段：${JSON.stringify(receptionAiSourceFields(input.sourceFields))}`,
    "售前会话的售后问题数组必须为空；售后会话的售前问题数组必须为空；混合会话可分别输出。",
    "必须逐项检查当前场景对应的全部规则，并把已检查的问题ID完整写入 checkedRuleIds；不适用和合规规则不进入问题数组。",
    "证据优先引用 dialogueTurns 的 id，并在 evidence 中保留最小必要原文。没有证据不得输出问题。",
    "只有缺失信息会改变本次结论时才放入 blockingUnverifiableItems；例行缺少后台数据但没有对应场景时不要列出。",
    "不要输出问题名称、分数、等级、违规次数、标签或建议，这些结果由程序生成。",
    `只返回合法 JSON，格式：${JSON.stringify(protocol)}`,
  ].join("\n");
  return [
    { role: "system", content: "你是客服接待流程质检助手。原文至上，严格区分客户、客服、机器人和系统消息，只返回合法 JSON。" },
    { role: "user", content: [{ type: "text", text }] },
  ];
}
