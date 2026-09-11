import type { AnalysisSection } from "../../shared/types";

export interface PromptInput {
  section: AnalysisSection;
  sourceFields: Record<string, string>;
  imageDataUrl: string;
}

export function buildVisionMessages(input: PromptInput) {
  const schema = input.section.outputSchema.map((field) => `${field.key}: ${field.type}`).join(", ");
  return [
    { role: "system", content: "你是客服聊天分析助手。只返回合法 JSON，不要 markdown，不要额外解释。" },
    {
      role: "user",
      content: [
        { type: "text", text: `解析板块：${input.section.name}\n任务：${input.section.prompt}\n辅助字段：${JSON.stringify(input.sourceFields)}\n输出字段：${schema}` },
        ...(input.section.imageEnabled === false ? [] : [{ type: "image_url", image_url: { url: input.imageDataUrl } }]),
      ],
    },
  ];
}
