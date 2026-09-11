import type { KnowledgeCandidate } from "../../shared/types";

export function buildKnowledgeMatchMessages(input: {
  sectionName: string;
  fieldPrompt: string;
  dependencies: Record<string, unknown>;
  candidates: KnowledgeCandidate[];
}): Array<{
  role: "system" | "user";
  content: string;
}> {
  const compactCandidates = input.candidates.map((candidate) => ({
    itemId: candidate.itemId,
    values: candidate.values,
  }));

  return [
    {
      role: "system",
      content: [
        "你是客服知识候选匹配助手。",
        "只能选择用户消息中提供的候选 ID，不能编造、改写或返回其他 ID。",
        '匹配时只返回合法 JSON：{"knowledgeItemId":"candidate-id"}。',
        '没有足够匹配项时返回：{"knowledgeItemId":""}。',
        "不要返回 Markdown、解释或其他字段。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `解析板块：${input.sectionName}`,
        `匹配要求：${input.fieldPrompt}`,
        `依赖字段：${JSON.stringify(input.dependencies)}`,
        `候选条目：${JSON.stringify(compactCandidates)}`,
      ].join("\n"),
    },
  ];
}
