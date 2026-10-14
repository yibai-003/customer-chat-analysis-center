import { describe, expect, it } from "vitest";
import { parseLegacyReceptionQuality } from "./reception-quality-legacy";
import { sectionBusinessRules } from "./section-business-rules";

function legacyQuality(
  overrides: Record<string, unknown>,
  businessRules?: Record<string, unknown>,
) {
  return parseLegacyReceptionQuality(JSON.stringify({
    scene: "售后",
    preSaleIssues: [],
    afterSaleIssues: [],
    confidence: 0.9,
    ...overrides,
  }), "统一质检分析", { businessRules });
}

function legacyIssue(issueId: string) {
  return {
    issueId,
    evidence: "可核验的会话原文",
    reason: "原文满足规则触发条件",
  };
}

describe("legacy reception quality scoring", () => {
  it("keeps pre-sale scoring unchanged", () => {
    const quality = legacyQuality({
      scene: "售前",
      preSaleIssues: [legacyIssue("PRE_ANSWER_IRRELEVANT")],
    });

    expect(quality).toMatchObject({
      totalDeduction: 10,
      score: 90,
      grade: "B",
      hasDLevelIssue: false,
      hasAfterSaleViolation: false,
    });
  });

  it("includes after-sale deductions when there are no pre-sale issues", () => {
    const quality = legacyQuality({
      afterSaleIssues: [legacyIssue("POST_NO_REPLY")],
    });

    expect(quality).toMatchObject({
      totalDeduction: 1,
      score: 99,
      grade: "A",
      hasDLevelIssue: false,
      hasAfterSaleViolation: true,
    });
  });

  it("applies deductions from both scopes and forces D for an after-sale D-level issue", () => {
    const quality = legacyQuality({
      scene: "混合",
      preSaleIssues: [legacyIssue("PRE_ANSWER_IRRELEVANT")],
      afterSaleIssues: [legacyIssue("POST_ATTITUDE")],
    });

    expect(quality).toMatchObject({
      totalDeduction: 20,
      score: 80,
      grade: "D",
      hasDLevelIssue: true,
      hasAfterSaleViolation: true,
    });
    expect(quality.preSaleIssues.map((issue) => issue.issueId)).toEqual([
      "PRE_ANSWER_IRRELEVANT",
    ]);
    expect(quality.afterSaleIssues.map((issue) => issue.issueId)).toEqual([
      "POST_ATTITUDE",
    ]);
  });

  it("keeps legacy name-based deduction de-duplication across both scopes", () => {
    const businessRules = structuredClone(sectionBusinessRules("reception"));
    const rules = businessRules.issues as Array<{ id: string; name: string }>;
    rules.find((rule) => rule.id === "PRE_ANSWER_IRRELEVANT")!.name = "共享问题名";
    rules.find((rule) => rule.id === "POST_NO_REPLY")!.name = "共享问题名";

    const quality = legacyQuality({
      scene: "混合",
      preSaleIssues: [legacyIssue("PRE_ANSWER_IRRELEVANT")],
      afterSaleIssues: [legacyIssue("POST_NO_REPLY")],
    }, businessRules);

    expect(quality.totalDeduction).toBe(1);
    expect(quality.score).toBe(99);
  });
});
