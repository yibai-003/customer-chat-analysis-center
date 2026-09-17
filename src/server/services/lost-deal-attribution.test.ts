import { describe, expect, it } from "vitest";
import {
  deriveLostDealFields,
  parseLostDealAttribution,
  type LostDealKnowledgeCandidates,
} from "./lost-deal-attribution";
import { buildLostDealScriptSuggestion } from "./lost-deal-script-rules";

const candidates: LostDealKnowledgeCandidates = {
  customerReasons: [
    { id: "customer-price", name: "价格超出预算", definition: "预算不足", applicable: "客户明确说贵或预算不足", excluded: "仅询问价格但未表达顾虑" },
    { id: "customer-size", name: "尺寸不合适", definition: "规格不匹配", applicable: "客户明确说尺寸不合适", excluded: "" },
  ],
  serviceReasons: [
    { id: "service-needs", name: "未确认需求", definition: "没有确认关键条件", applicable: "客服未询问关键需求", excluded: "" },
    { id: "service-concern", name: "未处理客户顾虑", definition: "客户顾虑没有得到回应", applicable: "客户提出顾虑且客服未回应", excluded: "" },
  ],
  demandTypes: ["价格需求", "尺寸需求"],
};

describe("lost-deal attribution", () => {
  it("parses bounded reason and demand arrays", () => {
    const result = parseLostDealAttribution(JSON.stringify({
      customerReasons: [{ knowledgeItemId: "customer-price", evidence: "客户说预算只有100元", confidence: 0.92 }],
      serviceReasons: [{ knowledgeItemId: "service-concern", evidence: "客户问能否退换，客服未回应", confidence: 0.81 }],
      demandTypes: [{ name: "价格需求", evidence: "客户询问优惠", confidence: 0.88 }],
      specificDemand: "希望优惠到100元",
      evidence: ["预算只有100元", "能否退换未获回复"],
      confidence: 0.86,
    }), candidates);

    expect(result.customerReasons).toHaveLength(1);
    expect(result.serviceReasons[0].name).toBe("未处理客户顾虑");
    expect(result.specificDemand).toBe("希望优惠到100元");
  });

  it("rejects names outside the supplied knowledge candidates", () => {
    expect(() => parseLostDealAttribution(JSON.stringify({
      customerReasons: [{ knowledgeItemId: "outside-id", evidence: "客户说贵", confidence: 0.9 }],
      serviceReasons: [],
      demandTypes: [],
      specificDemand: "",
      evidence: ["客户说贵"],
      confidence: 0.7,
    }), candidates)).toThrow(/知识库/);
  });

  it("retains a new name as a review proposal without treating it as a standard reason", () => {
    const result = parseLostDealAttribution(JSON.stringify({
      customerReasons: [{ name: "希望先试用", evidence: "客户说想先试用", confidence: 0.8 }],
      serviceReasons: [],
      demandTypes: [],
      specificDemand: "",
      evidence: ["客户说想先试用"],
      confidence: 0.8,
    }), candidates, { summary: "客户说想先试用", sourceFields: {} });
    expect(result.customerReasons[0]).toMatchObject({
      name: "待复核", proposedName: "希望先试用", evidence: "客户说想先试用",
    });
    expect(deriveLostDealFields(result).客户原因).toBe("待复核");
    expect(result.reviewRequired).toBe(true);
  });

  it("marks weak or unsupported attribution for review", () => {
    const result = parseLostDealAttribution(JSON.stringify({
      customerReasons: [{ knowledgeItemId: "customer-price", evidence: "", confidence: 0.2 }],
      serviceReasons: [],
      demandTypes: [],
      specificDemand: "",
      evidence: [],
      confidence: 0.2,
    }), candidates);

    expect(result.reviewRequired).toBe(true);
    expect(result.customerReasons[0].name).toBe("待复核");
    expect(result.customerReasons[0].evidence).toBe("");
  });

  it("marks evidence absent from the screenshot summary and source fields for review", () => {
    const result = parseLostDealAttribution(JSON.stringify({
      customerReasons: [{ knowledgeItemId: "customer-price", evidence: "客户说预算只有100元", confidence: 0.9 }],
      serviceReasons: [{ knowledgeItemId: "service-concern", evidence: "客服承诺明天到货", confidence: 0.9 }],
      demandTypes: [{ name: "价格需求", evidence: "客户询问优惠", confidence: 0.9 }],
      specificDemand: "希望优惠到100元",
      evidence: ["客户说预算只有100元", "客户从未提出的物流承诺"],
      confidence: 0.9,
    }), candidates, {
      summary: "客户说预算只有100元",
      sourceFields: { 聊天记录: "客户询问优惠" },
    });

    expect(result.customerReasons[0].name).toBe("价格超出预算");
    expect(result.serviceReasons[0].name).toBe("待复核");
    expect(result.serviceReasons[0].evidence).toBe("客服承诺明天到货");
    expect(result.demandTypes[0].name).toBe("价格需求");
    expect(result.reviewRequired).toBe(true);
  });

  it("requires overall evidence when an input context is provided", () => {
    const result = parseLostDealAttribution(JSON.stringify({
      customerReasons: [],
      serviceReasons: [],
      demandTypes: [],
      specificDemand: "",
      evidence: [],
      confidence: 0.9,
    }), candidates, { summary: "客户未明确说明原因", sourceFields: {} });
    expect(result.reviewRequired).toBe(true);
  });

  it("requires review when neither customer nor service reasons were identified", () => {
    const result = parseLostDealAttribution(JSON.stringify({
      customerReasons: [],
      serviceReasons: [],
      demandTypes: [{ name: "价格需求", evidence: "客户询问优惠", confidence: 0.9 }],
      specificDemand: "希望价格更优惠",
      specificDemandEvidence: "客户询问优惠",
      evidence: ["客户询问优惠"],
      confidence: 0.9,
    }), candidates, { summary: "客户询问优惠", sourceFields: {} });

    expect(result.reviewRequired).toBe(true);
  });

  it("requires grounded evidence for a non-empty specific demand", () => {
    const result = parseLostDealAttribution(JSON.stringify({
      customerReasons: [{ knowledgeItemId: "customer-price", evidence: "客户说预算只有100元", confidence: 0.9 }],
      serviceReasons: [],
      demandTypes: [{ name: "价格需求", evidence: "客户询问优惠", confidence: 0.9 }],
      specificDemand: "希望优惠到100元",
      specificDemandEvidence: "客户要求赠送两个配件",
      evidence: ["客户说预算只有100元"],
      confidence: 0.9,
    }), candidates, {
      summary: "客户说预算只有100元，并询问优惠",
      sourceFields: {},
    });

    expect(result.specificDemand).toBe("希望优惠到100元");
    expect(result.specificDemandEvidence).toBe("客户要求赠送两个配件");
    expect(result.reviewRequired).toBe(true);
    expect(deriveLostDealFields(result).客户产品需求).toBe("");
  });

  it("keeps string demand types reviewable instead of failing the whole attribution", () => {
    const result = parseLostDealAttribution(JSON.stringify({
      customerReasons: [{ knowledgeItemId: "customer-size", evidence: "客户说尺寸不合适", confidence: 0.9 }],
      serviceReasons: [],
      demandTypes: ["尺寸需求"],
      specificDemand: "需要更小尺寸",
      specificDemandEvidence: "客户说尺寸不合适",
      evidence: ["客户说尺寸不合适"],
      confidence: 0.9,
    }), candidates, {
      summary: "客户说尺寸不合适，需要更小尺寸",
      sourceFields: {},
    });

    expect(result.demandTypes).toEqual([{
      name: "待复核",
      proposedName: "尺寸需求",
      evidence: "",
      confidence: 0,
    }]);
    expect(result.reviewRequired).toBe(true);
  });

  it("keeps demand objects without evidence or confidence reviewable", () => {
    const result = parseLostDealAttribution(JSON.stringify({
      customerReasons: [{ knowledgeItemId: "customer-size", evidence: "客户说尺寸不合适", confidence: 0.9 }],
      serviceReasons: [],
      demandTypes: [{ name: "尺寸需求" }, { name: "价格需求" }],
      specificDemand: "需要更小尺寸",
      specificDemandEvidence: "客户说尺寸不合适",
      evidence: ["客户说尺寸不合适"],
      confidence: 0.9,
    }), candidates, {
      summary: "客户说尺寸不合适，需要更小尺寸",
      sourceFields: {},
    });

    expect(result.demandTypes).toEqual([
      { name: "待复核", proposedName: "尺寸需求", evidence: "", confidence: 0 },
      { name: "待复核", proposedName: "价格需求", evidence: "", confidence: 0 },
    ]);
    expect(result.reviewRequired).toBe(true);
  });

  it("derives public fields locally with newline separators", () => {
    const attribution = parseLostDealAttribution(JSON.stringify({
      customerReasons: [
        { knowledgeItemId: "customer-price", evidence: "客户说贵", confidence: 0.9 },
        { knowledgeItemId: "customer-size", evidence: "客户说放不下", confidence: 0.8 },
      ],
      serviceReasons: [{ knowledgeItemId: "service-needs", evidence: "未询问尺寸", confidence: 0.8 }],
      demandTypes: [{ name: "价格需求", evidence: "询问优惠", confidence: 0.9 }],
      specificDemand: "需要更小尺寸",
      evidence: ["客户说贵", "客户说放不下"],
      confidence: 0.85,
    }), candidates);

    expect(deriveLostDealFields(attribution)).toMatchObject({
      客户原因: "价格超出预算\n尺寸不合适",
      客服原因: "未确认需求",
      客户产品需求: "需要更小尺寸",
    });
  });

  it.each([
    {
      name: "price and unclear discount pair",
      customerReasons: ["价格超出预算"],
      serviceReasons: ["优惠说明不清晰"],
      expected: "先确认客户预算，再清晰说明到手价和优惠条件，并确认该方案是否可接受。",
    },
    {
      name: "product fit and inaccurate recommendation pair",
      customerReasons: ["产品功能不符合需求"],
      serviceReasons: ["产品推荐不准确"],
      expected: "先确认客户的核心功能和使用场景，再推荐匹配方案并说明关键差异。",
    },
    {
      name: "service response without a customer reason",
      customerReasons: [],
      serviceReasons: ["回复不及时"],
      expected: "及时回应客户并确认仍待解决的问题，再给出明确处理时点。",
    },
    {
      name: "unknown customer and service combination",
      customerReasons: ["正在比较其他商品"],
      serviceReasons: ["未提供成交引导"],
      expected: "围绕客户已表达的顾虑给出具体方案，补充下一步引导并确认购买意向。",
    },
    {
      name: "customer and service concern pair",
      customerReasons: ["对品质或效果有顾虑"],
      serviceReasons: ["保障说明不足"],
      expected: "先回应客户的品质顾虑，再说明售后保障和适用边界，并确认是否仍有疑问。",
    },
  ])("uses deterministic pair-aware rules for $name", ({ customerReasons, serviceReasons, expected }) => {
    expect(buildLostDealScriptSuggestion({
      customerReasons,
      serviceReasons,
      evidence: ["聊天中存在明确依据"],
    })).toBe(expected);
  });

  it("returns the review sentence when both sides are unknown", () => {
    expect(buildLostDealScriptSuggestion({
      customerReasons: [],
      serviceReasons: [],
      evidence: [],
    })).toBe("无明确未成交依据，建议人工复核后再优化话术");
  });
});
