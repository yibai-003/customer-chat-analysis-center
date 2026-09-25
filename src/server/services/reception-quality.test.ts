import { describe, expect, it } from "vitest";
import {
  buildReceptionQualityMessages,
  deriveReceptionConversationFacts,
  deriveReceptionQualityFields,
  parseReceptionQuality,
  parseReceptionScreenshotFacts,
  type ReceptionScene,
  type ReceptionScreenshotFacts,
} from "./reception-quality";
import {
  receptionBusinessRules,
  sectionBusinessRules,
  type ReceptionBusinessRules,
} from "./section-business-rules";

const canonicalRules = receptionBusinessRules(sectionBusinessRules("reception"));

function checkedRuleIds(
  scene: ReceptionScene,
  rules: ReceptionBusinessRules = canonicalRules,
) {
  return rules.issues
    .filter((rule) => scene === "混合"
      || scene === "无法判断"
      || (scene === "售前" ? rule.scope === "preSale" : rule.scope === "afterSale"))
    .map((rule) => rule.id);
}

function completeFacts(): ReceptionScreenshotFacts {
  return deriveReceptionConversationFacts({
    sceneHints: ["售前", "售后"],
    dialogueTurns: [
      { id: "T1", speaker: "客户", time: "2026-09-22 09:30", text: "尺寸多大" },
      { id: "T2", speaker: "客服", time: "09:31", text: "请看详情页" },
      { id: "T3", speaker: "客服", time: "09:32", text: "您开心就好" },
      { id: "T4", speaker: "客户", time: "09:33", text: "我要退款" },
    ],
    customerIntents: ["咨询尺寸", "申请退款"],
    serviceActions: ["回复详情页"],
    businessFacts: [],
    missingSignals: [],
  });
}

function issue(
  issueId: string,
  evidenceId: string,
  chatQuote: string,
) {
  return {
    issueId,
    evidenceIds: [evidenceId],
    chatQuotes: [chatQuote],
    evidenceExplanation: "相关原文满足规则要求",
    reason: "适用且命中触发条件，未命中排除条件",
  };
}

function qualityResponse(
  scene: ReceptionScene,
  overrides: Partial<{
    checkedRuleIds: string[];
    preSaleIssues: ReturnType<typeof issue>[];
    afterSaleIssues: ReturnType<typeof issue>[];
    blockingUnverifiableItems: string[];
    informationalUnverifiableItems: string[];
    confidence: number;
  }> = {},
  rules: ReceptionBusinessRules = canonicalRules,
) {
  return {
    scene,
    checkedRuleIds: checkedRuleIds(scene, rules),
    preSaleIssues: [],
    afterSaleIssues: [],
    blockingUnverifiableItems: [],
    informationalUnverifiableItems: [],
    confidence: 0.9,
    ...overrides,
  };
}

function qualityField(prompt = "版本质检提示词") {
  return {
    id: "quality",
    sectionId: "reception",
    key: "统一质检分析",
    label: "统一质检分析",
    type: "object" as const,
    prompt,
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
}

describe("reception screenshot facts", () => {
  it("derives a reliable start time and counts only customer-group to human-agent replies", () => {
    const facts = parseReceptionScreenshotFacts(JSON.stringify({
      截图内容总结: {
        sceneHints: ["售前"],
        dialogueTurns: [
          { id: "T1", speaker: "客户", time: "2026年9月22日 09:30", text: "第一条" },
          { id: "T2", speaker: "客户", time: "09:30", text: "补充一条" },
          { id: "T3", speaker: "机器人", time: "09:30", text: "自动回复" },
          { id: "T4", speaker: "系统", time: "09:31", text: "系统提示" },
          { id: "T5", speaker: "客服", time: "09:32", text: "人工回复" },
          { id: "T6", speaker: "客户", time: "09:33", text: "末尾未回复" },
        ],
        customerIntents: ["咨询"],
        serviceActions: ["人工回复"],
        businessFacts: [],
        missingSignals: [],
      },
    }));

    expect(facts).toMatchObject({
      conversationStartTime: "2026年9月22日 09:30",
      conversationRoundCount: 1,
      reviewReasons: [],
    });
  });

  it("leaves an unreliable start time blank, marks review, and rejects extra model fields", () => {
    const facts = parseReceptionScreenshotFacts(JSON.stringify({
      截图内容总结: {
        sceneHints: ["售前"],
        dialogueTurns: [
          { id: "T1", speaker: "客户", time: "09:30", text: "尺寸多大" },
        ],
        customerIntents: ["咨询尺寸"],
        serviceActions: [],
        businessFacts: [],
        missingSignals: [],
      },
    }));
    expect(facts.conversationStartTime).toBe("");
    expect(facts.reviewReasons).toEqual([
      "会话开始时间：Excel 和聊天记录均无法可靠识别完整日期和时间",
    ]);

    expect(() => parseReceptionScreenshotFacts(JSON.stringify({
      截图内容总结: {
        sceneHints: [],
        dialogueTurns: [],
        customerIntents: [],
        serviceActions: [],
        businessFacts: [],
        missingSignals: [],
        grade: "A",
      },
    }))).toThrow("结构不符合 Schema");
  });

  it("prefers a valid Excel start time and preserves its original format", () => {
    const facts = parseReceptionScreenshotFacts(JSON.stringify({
      截图内容总结: {
        sceneHints: ["售前"],
        dialogueTurns: [
          { id: "T1", speaker: "客户", time: "2026-09-22 09:30", text: "第一条" },
        ],
        customerIntents: [],
        serviceActions: [],
        businessFacts: [],
        missingSignals: [],
      },
    }), "截图内容总结", {
      "会话开始时间 (conversation_started_at)": "2026年9月22日 09:20",
    });

    expect(facts.conversationStartTime).toBe("2026年9月22日 09:20");
    expect(facts.reviewReasons).toEqual([]);
  });

  it("falls back to the earliest explicit chat timestamp when Excel time is invalid", () => {
    const facts = parseReceptionScreenshotFacts(JSON.stringify({
      截图内容总结: {
        sceneHints: ["售前"],
        dialogueTurns: [
          { id: "T1", speaker: "客户", time: "2026-09-22 09:30", text: "第二条" },
          { id: "T2", speaker: "客服", time: "2026/9/22 09:20", text: "第一条" },
        ],
        customerIntents: [],
        serviceActions: [],
        businessFacts: [],
        missingSignals: [],
      },
    }), "截图内容总结", {
      "会话开始时间 (conversation_started_at)": "无法识别",
    });

    expect(facts.conversationStartTime).toBe("2026/9/22 09:20");
    expect(facts.reviewReasons).toEqual([]);
  });

  it("combines a matching Excel business date with a month-day chat timestamp", () => {
    const facts = parseReceptionScreenshotFacts(JSON.stringify({
      截图内容总结: {
        sceneHints: ["售前"],
        dialogueTurns: [
          { id: "T1", speaker: "客户", time: "07-16 23:38:33", text: "咨询尺码" },
          { id: "T2", speaker: "客服", time: "07-16 23:38:38", text: "推荐70圈" },
        ],
        customerIntents: [],
        serviceActions: [],
        businessFacts: [],
        missingSignals: [],
      },
    }), "截图内容总结", {
      "业务日期 (business_date)": "2026-07-16",
    });

    expect(facts.conversationStartTime).toBe("2026-07-16 23:38:33");
    expect(facts.reviewReasons).toEqual([]);
  });

  it("keeps a month-day chat timestamp blank when it conflicts with the Excel business date", () => {
    const facts = parseReceptionScreenshotFacts(JSON.stringify({
      截图内容总结: {
        sceneHints: ["售前"],
        dialogueTurns: [
          { id: "T1", speaker: "客户", time: "07-16 23:38:33", text: "咨询尺码" },
        ],
        customerIntents: [],
        serviceActions: [],
        businessFacts: [],
        missingSignals: [],
      },
    }), "截图内容总结", {
      "业务日期 (business_date)": "2026-07-17",
    });

    expect(facts.conversationStartTime).toBe("");
    expect(facts.reviewReasons).toEqual([
      "会话开始时间：Excel 和聊天记录均无法可靠识别完整日期和时间",
    ]);
  });
});

describe("reception quality", () => {
  it("requires every confirmed issue rule to carry a positive deduction", () => {
    expect(canonicalRules.issues.every((rule) => rule.deduction > 0)).toBe(true);
    expect(canonicalRules.issues.filter((rule) => rule.forceD).every((rule) => rule.deduction >= 5)).toBe(true);
  });

  it("derives dimensions, multi-issue deductions, D override, and suggestions from local version rules", () => {
    const quality = parseReceptionQuality(JSON.stringify(qualityResponse("混合", {
      preSaleIssues: [
        issue("PRE_DUPLICATE", "T2", "请看详情页"),
        issue("PRE_ANSWER_IRRELEVANT", "T2", "请看详情页"),
        issue("PRE_BAD_ATTITUDE", "T3", "您开心就好"),
      ],
      afterSaleIssues: [
        issue("POST_NO_REPLY", "T4", "我要退款"),
      ],
    })), {
      screenshotFacts: completeFacts(),
      businessRules: canonicalRules as unknown as Record<string, unknown>,
    });

    expect(quality).toMatchObject({
      totalDeduction: 23,
      score: 77,
      grade: "D",
      hasDLevelIssue: true,
      hasAfterSaleViolation: true,
      labels: ["态度差D级", "重复发送", "答非所问", "漏回复"],
      dimensions: ["服务态度", "服务规范", "问题解决", "响应时效"],
      reviewRequired: false,
    });
    expect(quality.preSaleIssues[1]).toMatchObject({
      issueId: "PRE_ANSWER_IRRELEVANT",
      dimension: "问题解决",
      deduction: 10,
      forceD: false,
    });
    expect(deriveReceptionQualityFields(quality)).toMatchObject({
      "有无违规-售后": "有违规",
      "接待流程质检结果": "D",
      "客服问题识别问题并打标签": "态度差D级/重复发送/答非所问/漏回复",
      "问题": "态度差D级/重复发送/答非所问/漏回复",
      "维度": "服务态度/服务规范/问题解决/响应时效",
      "扣分": "10/2/10/1",
      "聊天原文": "您开心就好/请看详情页/请看详情页/我要退款",
      "证据说明": "相关原文满足规则要求/相关原文满足规则要求/相关原文满足规则要求/相关原文满足规则要求",
      "判定理由": "适用且命中触发条件，未命中排除条件/适用且命中触发条件，未命中排除条件/适用且命中触发条件，未命中排除条件/适用且命中触发条件，未命中排除条件",
      "合计扣分": 23,
      "等级": "D",
      "是否D级": "是",
      "是否待人工复核": "否",
    });
  });

  it("keeps derived issue fields aligned, escapes delimiter slashes, and flags mismatched values", () => {
    const quality = parseReceptionQuality(JSON.stringify(qualityResponse("混合", {
      preSaleIssues: [
        issue("PRE_ANSWER_IRRELEVANT", "T2", "请看详情页"),
        issue("PRE_BAD_ATTITUDE", "T3", "您开心就好"),
      ],
    })), { screenshotFacts: completeFacts() });
    const answerIssue = quality.preSaleIssues.find((item) => item.name === "答非所问")!;
    const answerIndex = quality.labels.indexOf("答非所问");
    quality.labels[answerIndex] = "答非所问/特别";
    answerIssue.name = "答非所问/特别";
    answerIssue.dimension = "问题/解决";
    answerIssue.chatQuotes = ["客服：请看/链接", "客服：请看/链接", "客服：补充链接"];
    answerIssue.evidenceExplanation = "证据/一";
    answerIssue.reason = "理由/一";
    quality.dimensions[answerIndex] = "问题/解决";
    quality.deductions.pop();

    expect(deriveReceptionQualityFields(quality)).toMatchObject({
      "客服问题识别问题并打标签": "态度差D级/答非所问／特别",
      "问题": "态度差D级/答非所问／特别",
      "维度": "服务态度/问题／解决",
      "扣分": "10/",
      "聊天原文": "您开心就好/客服：请看／链接；客服：请看／链接；客服：补充链接",
      "证据说明": "相关原文满足规则要求/证据／一",
      "判定理由": "适用且命中触发条件，未命中排除条件/理由／一",
      "是否待人工复核": "是",
    });
  });

  it("leaves derived issue fields blank and requests review when issue details have no labels", () => {
    const quality = parseReceptionQuality(JSON.stringify(qualityResponse("售前", {
      preSaleIssues: [issue("PRE_ANSWER_IRRELEVANT", "T2", "请看详情页")],
    })), { screenshotFacts: completeFacts() });
    quality.labels = [];

    expect(deriveReceptionQualityFields(quality)).toMatchObject({
      "问题": "",
      "维度": "",
      "扣分": "",
      "聊天原文": "",
      "证据说明": "",
      "判定理由": "",
      "是否待人工复核": "是",
    });
  });

  it("rejects directory-external IDs and model-supplied scoring fields", () => {
    expect(() => parseReceptionQuality(JSON.stringify(qualityResponse("售前", {
      preSaleIssues: [issue("PRE_NOT_CONFIGURED", "T2", "请看详情页")],
    })), { screenshotFacts: completeFacts() })).toThrow("目录外问题 ID");

    expect(() => parseReceptionQuality(JSON.stringify({
      ...qualityResponse("售前", {
        preSaleIssues: [issue("PRE_ANSWER_IRRELEVANT", "T2", "请看详情页")],
      }),
      score: 0,
    }), { screenshotFacts: completeFacts() })).toThrow("结构不符合 Schema");

    const responseWithModelDeduction: Record<string, unknown> = qualityResponse("售前", {
      preSaleIssues: [issue("PRE_ANSWER_IRRELEVANT", "T2", "请看详情页")],
    });
    responseWithModelDeduction.preSaleIssues = [{
      ...issue("PRE_ANSWER_IRRELEVANT", "T2", "请看详情页"),
      deduction: 99,
    }];
    expect(() => parseReceptionQuality(JSON.stringify(responseWithModelDeduction), {
      screenshotFacts: completeFacts(),
    })).toThrow("结构不符合 Schema");
  });

  it("applies configured grade thresholds at A, B, C, and D boundaries", () => {
    const grades = [
      [5, "A"],
      [10, "B"],
      [20, "C"],
      [21, "D"],
    ] as const;
    for (const [deduction, grade] of grades) {
      const rules = structuredClone(canonicalRules);
      rules.issues.find((rule) => rule.id === "PRE_ANSWER_IRRELEVANT")!.deduction = deduction;
      const quality = parseReceptionQuality(JSON.stringify(qualityResponse("售前", {
        preSaleIssues: [issue("PRE_ANSWER_IRRELEVANT", "T2", "请看详情页")],
      }, rules)), {
        screenshotFacts: completeFacts(),
        businessRules: rules as unknown as Record<string, unknown>,
      });
      expect(quality.grade).toBe(grade);
    }
  });

  it("returns clean no-issue output when evidence is sufficient", () => {
    const quality = parseReceptionQuality(JSON.stringify(qualityResponse("售前")), {
      screenshotFacts: completeFacts(),
    });

    expect(quality).toMatchObject({
      totalDeduction: 0,
      score: 100,
      grade: "A",
      reviewRequired: false,
      labels: [],
      dimensions: [],
      suggestion: "",
    });
    expect(deriveReceptionQualityFields(quality)).toMatchObject({
      "问题点-售前": "",
      "问题点-售后": "",
      "客服问题识别问题并打标签": "",
      "优化建议-售前": "",
      "接待流程质检结果": "A",
      "问题": "",
      "合计扣分": 0,
      "等级": "A",
      "是否D级": "",
      "是否待人工复核": "否",
    });
  });

  it("does not invent issues when evidence is insufficient and marks review", () => {
    const facts = {
      ...completeFacts(),
      conversationStartTime: "",
      reviewReasons: ["会话开始时间：截图无法可靠识别完整日期和时间"],
    };
    const quality = parseReceptionQuality(JSON.stringify(qualityResponse("售前", {
      blockingUnverifiableItems: ["商品知识缺少权威资料"],
      confidence: 0.4,
    })), { screenshotFacts: facts });

    expect(quality.preSaleIssues).toEqual([]);
    expect(quality.afterSaleIssues).toEqual([]);
    expect(quality.grade).toBe("A");
    expect(quality.reviewRequired).toBe(true);
    expect(quality.unverifiableItems).toEqual(expect.arrayContaining([
      "商品知识缺少权威资料",
      "会话开始时间：截图无法可靠识别完整日期和时间",
    ]));
  });

  it("uses the bound prompt, issue rules, and knowledge snapshot in model context", () => {
    const rules = structuredClone(canonicalRules);
    rules.issues.find((rule) => rule.id === "PRE_ANSWER_IRRELEVANT")!.triggerWhen = [
      "版本专属触发条件",
    ];
    const messages = buildReceptionQualityMessages({
      field: qualityField("绑定版本专属提示词"),
      screenshotFacts: completeFacts(),
      sourceFields: {},
      businessRules: rules as unknown as Record<string, unknown>,
      knowledgeSnapshot: [{
        id: "bound-base",
        name: "版本知识库",
        isEnabled: true,
        items: [{
          id: "bound-item",
          isEnabled: true,
          values: { 规则: "BOUND_KNOWLEDGE_SENTINEL" },
        }],
      }],
    });
    const text = JSON.stringify(messages);

    expect(text).toContain("绑定版本专属提示词");
    expect(text).toContain("版本专属触发条件");
    expect(text).toContain("BOUND_KNOWLEDGE_SENTINEL");
    expect(text).toContain("参考结果示例与版本问题目录或规则冲突，以版本规则为准");
    expect(text).not.toContain('"deduction"');
    expect(text).not.toContain('"forceD"');
    expect(text).not.toContain('"grade"');
  });

  it("marks incomplete coverage and untraceable evidence for review without retaining the issue", () => {
    const quality = parseReceptionQuality(JSON.stringify(qualityResponse("售前", {
      checkedRuleIds: ["PRE_ANSWER_IRRELEVANT"],
      preSaleIssues: [issue("PRE_ANSWER_IRRELEVANT", "T99", "不存在的原文")],
    })), { screenshotFacts: completeFacts() });

    expect(quality.preSaleIssues).toEqual([]);
    expect(quality.totalDeduction).toBe(0);
    expect(quality.reviewRequired).toBe(true);
    expect(quality.unverifiableItems).toEqual(expect.arrayContaining([
      expect.stringContaining("规则覆盖不完整"),
      "答非所问：证据编号无法回溯到截图事实",
    ]));
  });

  it("only sends original business columns and excludes historical result columns", () => {
    const messages = buildReceptionQualityMessages({
      field: qualityField(),
      screenshotFacts: completeFacts(),
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
