import { describe, expect, it } from "vitest";
import {
  buildReceptionQualityMessages,
  deriveReceptionQualityFields,
  parseReceptionQuality,
} from "./reception-quality";
import { sectionBusinessRules } from "./section-business-rules";

describe("reception quality", () => {
  it("calculates deterministic score, grade, labels and after-sale status", () => {
    const quality = parseReceptionQuality(JSON.stringify({
      scene: "混合",
      preSaleIssues: [
        { name: "答非所问", evidence: "客服：请看详情页", reason: "没有回答尺寸问题", deduction: 10, forceD: false, violationCount: 1 },
        { name: "态度差D级", evidence: "客服：您开心就好", reason: "存在讥讽", deduction: 0, forceD: true, violationCount: 1 },
      ],
      afterSaleIssues: [
        { name: "漏回复", evidence: "买家提出退款后无人工回复", reason: "没有有效回应", deduction: 0, forceD: false, violationCount: 1 },
      ],
      unverifiableItems: [],
      suggestion: "先准确回答尺寸，再礼貌说明售后方案",
      confidence: 0.9,
    }));
    expect(quality).toMatchObject({
      score: 90,
      grade: "D",
      hasAfterSaleViolation: true,
      labels: ["态度差D级", "答非所问", "漏回复"],
      reviewRequired: false,
    });
    expect(deriveReceptionQualityFields(quality)).toMatchObject({
      "有无违规-售后": "有违规",
      "接待流程质检结果": "D",
      "客服问题识别问题并打标签": "态度差D级、答非所问、漏回复",
    });
  });

  it("marks unknown or unverifiable analysis for review without inventing violations", () => {
    const quality = parseReceptionQuality(JSON.stringify({
      统一质检分析: {
        scene: "无法判断",
        preSaleIssues: [],
        afterSaleIssues: [],
        unverifiableItems: ["平均响应超时：缺少可靠时间戳"],
        suggestion: "",
        confidence: 0.4,
      },
    }));
    expect(quality.reviewRequired).toBe(true);
    expect(deriveReceptionQualityFields(quality)).toMatchObject({
      "有无违规-售后": "无违规",
      "客服问题识别问题并打标签": "待人工核验",
      "接待流程质检结果": "A",
    });
  });

  it("rejects issues without evidence", () => {
    expect(() => parseReceptionQuality(JSON.stringify({
      scene: "售前",
      preSaleIssues: [{ name: "答非所问", evidence: "", reason: "无回答", deduction: 10 }],
      afterSaleIssues: [],
      unverifiableItems: [],
      confidence: 0.9,
    }))).toThrow("必须包含问题名、证据和理由");
  });

  it("uses canonical local rules instead of model-provided scoring fields", () => {
    const quality = parseReceptionQuality(JSON.stringify({
      scene: "售前",
      preSaleIssues: [{
        issueId: "PRE_ANSWER_IRRELEVANT",
        evidence: "客服：请看详情页",
        reason: "没有回答客户的尺寸问题",
        deduction: 99,
        forceD: true,
        violationCount: 20,
      }],
      afterSaleIssues: [],
      blockingUnverifiableItems: [],
      informationalUnverifiableItems: [],
      confidence: 0.9,
    }));

    expect(quality.preSaleIssues).toEqual([
      expect.objectContaining({
        issueId: "PRE_ANSWER_IRRELEVANT",
        name: "答非所问",
        deduction: 10,
        forceD: false,
        violationCount: 1,
      }),
    ]);
    expect(quality).toMatchObject({
      score: 90,
      grade: "B",
      labels: ["答非所问"],
      reviewRequired: false,
    });
  });

  it("uses a bound business-rule snapshot for scoring and the model catalog", () => {
    const rules = structuredClone(sectionBusinessRules("reception"));
    const issues = rules.issues as Array<{ id: string; deduction: number; suggestion: string; triggerWhen: string[] }>;
    const target = issues.find((rule) => rule.id === "PRE_ANSWER_IRRELEVANT")!;
    target.deduction = 2;
    target.suggestion = "版本专属建议";
    target.triggerWhen = ["版本专属触发条件"];
    const field = {
      id: "quality",
      sectionId: "reception",
      key: "统一质检分析",
      label: "统一质检分析",
      type: "object" as const,
      prompt: "",
      options: [],
      required: true,
      imageEnabled: false,
      dependsOn: ["截图内容总结"],
      sortOrder: 1,
      executionType: "reception_quality_analysis" as const,
      exportEnabled: false,
      candidateLimit: 15,
      knowledgeSyncEnabled: false,
      knowledgeCaptureLimit: 2 as const,
      isEnabled: true,
    };
    const messages = buildReceptionQualityMessages({
      field,
      screenshotFacts: {},
      sourceFields: {},
      businessRules: rules,
    });
    expect(JSON.stringify(messages)).toContain("版本专属触发条件");
    const quality = parseReceptionQuality(JSON.stringify({
      scene: "售前",
      preSaleIssues: [{
        issueId: "PRE_ANSWER_IRRELEVANT",
        evidence: "答非所问",
        reason: "没有回答问题",
      }],
      afterSaleIssues: [],
      confidence: 0.9,
    }), "统一质检分析", { businessRules: rules });
    expect(quality).toMatchObject({ score: 98, grade: "A", suggestion: "版本专属建议" });
  });

  it("only sends the compact protocol and canonical issue ids to the quality model", () => {
    const messages = buildReceptionQualityMessages({
      field: {
        id: "quality",
        sectionId: "reception",
        key: "统一质检分析",
        label: "统一质检分析",
        type: "object",
        prompt: "OLD_PROMPT_SHOULD_NOT_BE_SENT".repeat(1000),
        options: [],
        required: true,
        imageEnabled: false,
        dependsOn: ["截图内容总结"],
        sortOrder: 1,
        executionType: "reception_quality_analysis",
        exportEnabled: false,
        candidateLimit: 15,
        knowledgeSyncEnabled: false,
        knowledgeCaptureLimit: 2,
        isEnabled: true,
      },
      screenshotFacts: {
        sceneHints: ["售前"],
        dialogueTurns: [{ id: "T1", speaker: "客户", time: "", text: "尺寸多大" }],
      },
      sourceFields: {},
    });
    const text = JSON.stringify(messages);

    expect(text).toContain("PRE_ANSWER_IRRELEVANT");
    expect(text).not.toContain("POST_NO_REGISTRATION");
    expect(text).toContain("checkedRuleIds");
    expect(text).toContain("evidenceIds");
    expect(text).toContain("客服已完成有效答疑");
    expect(text).toContain("客户尚未下单");
    expect(text).toContain("缺少订单状态");
    expect(text).not.toContain("OLD_PROMPT_SHOULD_NOT_BE_SENT");
    expect(text).not.toContain("聊天内容完整概述");
    expect(text).not.toContain('"deduction"');
    expect(text).not.toContain('"forceD"');
    expect(text).not.toContain('"violationCount"');
    expect(text.length).toBeLessThan(18_000);
  });

  it("marks incomplete rule coverage for review when the model reports its checked rules", () => {
    const quality = parseReceptionQuality(JSON.stringify({
      scene: "售前",
      checkedRuleIds: ["PRE_ANSWER_IRRELEVANT"],
      preSaleIssues: [],
      afterSaleIssues: [],
      blockingUnverifiableItems: [],
      informationalUnverifiableItems: [],
      confidence: 0.9,
    }));

    expect(quality.reviewRequired).toBe(true);
    expect(quality.unverifiableItems).toEqual([
      expect.stringContaining("规则覆盖不完整"),
    ]);
  });

  it("removes violations whose evidence ids cannot be traced to screenshot facts", () => {
    const quality = parseReceptionQuality(JSON.stringify({
      scene: "售前",
      preSaleIssues: [{
        issueId: "PRE_ANSWER_IRRELEVANT",
        evidenceIds: ["T99"],
        evidence: "客服：请看详情页",
        reason: "没有回答客户问题",
      }],
      afterSaleIssues: [],
      blockingUnverifiableItems: [],
      informationalUnverifiableItems: [],
      confidence: 0.9,
    }), "统一质检分析", {
      screenshotFacts: {
        dialogueTurns: [{ id: "T1", speaker: "客户", time: "", text: "尺寸多大" }],
      },
    });

    expect(quality.preSaleIssues).toEqual([]);
    expect(quality.score).toBe(100);
    expect(quality.reviewRequired).toBe(true);
    expect(quality.unverifiableItems).toContain("答非所问：证据编号无法回溯到截图事实");
  });

  it("only sends original business columns and normalizes the product code alias", () => {
    const messages = buildReceptionQualityMessages({
      field: {
        id: "quality",
        sectionId: "reception",
        key: "统一质检分析",
        label: "统一质检分析",
        type: "object",
        prompt: "",
        options: [],
        required: true,
        imageEnabled: false,
        dependsOn: ["截图内容总结"],
        sortOrder: 1,
        executionType: "reception_quality_analysis",
        exportEnabled: false,
        candidateLimit: 15,
        knowledgeSyncEnabled: false,
        knowledgeCaptureLimit: 2,
        isEnabled: true,
      },
      screenshotFacts: { sceneHints: ["售前"], dialogueTurns: [] },
      sourceFields: {
        平台: "京东",
        商品编码: "SKU-1",
        "问题点-售前": "历史结果",
        "客服问题 识别问题并打标签": "历史标签",
        组长复检文本: "历史复检",
        创建时间: "2026-01-01",
      },
    });
    const text = (messages[1].content[0] as { type: string; text: string }).text;

    expect(text).toContain('"平台店铺商品编码":"SKU-1"');
    expect(text).not.toContain("历史结果");
    expect(text).not.toContain("历史标签");
    expect(text).not.toContain("历史复检");
    expect(text).not.toContain("2026-01-01");
  });
});
