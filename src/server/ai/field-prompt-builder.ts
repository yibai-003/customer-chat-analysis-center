import type { AnalysisField } from "../../shared/types";

export interface FieldPromptInput {
  field: AnalysisField;
  sectionName: string;
  sourceFields: Record<string, string>;
  dependencyResults: Record<string, unknown>;
  imageDataUrl: string;
}

export function buildFieldMessages(input: FieldPromptInput) {
  const text = [
    `解析板块：${input.sectionName}`,
    `目标字段：${input.field.label}（${input.field.key}）`,
    `字段类型：${input.field.type}`,
    `字段说明：${input.field.prompt}`,
    ...(input.field.options?.length ? [`可选值：${JSON.stringify(input.field.options)}`] : []),
    "如能从来源中找到依据，同时返回 evidence 字段；没有依据时返回空字符串。",
    `辅助字段：${JSON.stringify(input.sourceFields)}`,
    `依赖字段结果：${JSON.stringify(input.dependencyResults)}`,
    `只输出目标字段 Key "${input.field.key}" 对应的 JSON 对象，不要输出其它字段、Markdown 或解释。`,
  ].join("\n");
  return [
    { role: "system", content: "你是结构化客服数据解析助手。只返回合法 JSON。" },
    {
      role: "user",
      content: [
        { type: "text", text },
        ...(input.field.imageEnabled && input.imageDataUrl
          ? [{ type: "image_url", image_url: { url: input.imageDataUrl } }]
          : []),
      ],
    },
  ];
}
