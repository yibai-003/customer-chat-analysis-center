interface ScriptInput {
  customerReasons: string[];
  serviceReasons: string[];
  evidence: string[];
}

export function buildLostDealScriptSuggestion(input: ScriptInput): string {
  const customer = input.customerReasons.join(" ");
  const service = input.serviceReasons.join(" ");
  if (!customer && !service) return "无明确未成交依据，建议人工复核后再优化话术";
  if (customer.includes("价格超出预算") && service.includes("优惠说明不清晰")) {
    return "先确认客户预算，再清晰说明到手价和优惠条件，并确认该方案是否可接受。";
  }
  if ((customer.includes("产品功能不符合需求") || customer.includes("规格或尺寸不合适"))
    && service.includes("产品推荐不准确")) {
    return "先确认客户的核心功能和使用场景，再推荐匹配方案并说明关键差异。";
  }
  if (service.includes("回复不及时")) {
    return "及时回应客户并确认仍待解决的问题，再给出明确处理时点。";
  }
  if (customer.includes("对品质或效果有顾虑") && service.includes("保障说明不足")) {
    return "先回应客户的品质顾虑，再说明售后保障和适用边界，并确认是否仍有疑问。";
  }
  if (customer && service.includes("未提供成交引导")) {
    return "围绕客户已表达的顾虑给出具体方案，补充下一步引导并确认购买意向。";
  }
  if (customer.includes("价格") || customer.includes("预算")) {
    return "针对预算顾虑先说明当前优惠与性价比，并确认客户可接受的价格区间。";
  }
  if (customer.includes("尺寸") || customer.includes("规格") || customer.includes("适配")) {
    return "先确认使用场景和尺寸限制，再推荐明确适配的规格并说明差异。";
  }
  if (service.includes("顾虑") || service.includes("未处理")) {
    return "针对客户提出的顾虑逐项回应，并给出明确的保障、时效或售后承诺。";
  }
  if (service.includes("需求")) {
    return "先追问客户的核心使用需求和限制条件，再给出针对性推荐与下一步引导。";
  }
  return input.evidence.length
    ? "围绕聊天中已出现的顾虑给出直接、具体的解决方案，并确认客户是否还有其他疑问。"
    : "依据不足，建议人工复核后再优化话术";
}
