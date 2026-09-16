interface ScriptInput {
  customerReasons: string[];
  serviceReasons: string[];
  evidence: string[];
}

export function buildLostDealScriptSuggestion(input: ScriptInput): string {
  const customer = input.customerReasons.join(" ");
  const service = input.serviceReasons.join(" ");
  if (!customer && !service) return "无明确未成交依据，建议人工复核后再优化话术";
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
