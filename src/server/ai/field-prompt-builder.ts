import type { AnalysisField } from "../../shared/types";

export interface FieldPromptInput {
  field: AnalysisField;
  sectionName: string;
  sourceFields: Record<string, string>;
  dependencyResults: Record<string, unknown>;
  imageDataUrl: string;
}

export function buildFieldMessages(input: FieldPromptInput) {
  const exampleValue = input.field.type === "string" ? "解析内容" : input.field.type === "object" ? { 内容: "解析内容" } : input.field.type === "number" ? 0 : false;
  const protocol = `响应外层必须是 JSON 对象，目标键为 ${JSON.stringify(input.field.key)}，该键的值类型必须为 ${input.field.type}。`
    + (input.field.type === "string" ? "值必须是带双引号的字符串，不能是对象或数组；多行内容使用 JSON 换行转义。" : "")
    + `格式示例（不是分析答案）：${JSON.stringify({ [input.field.key]: exampleValue, evidence: "" })}。`
    + "字段说明中的排版要求仅用于目标字段值，不得覆盖本响应协议。evidence 为可选的字符串依据。";
  const text = [
    `解析板块：${input.sectionName}`,
    `目标字段：${input.field.label}（${input.field.key}）`,
    `字段类型：${input.field.type}`,
    `字段说明：${input.field.prompt}`,
    ...(input.field.options?.length ? [`可选值：${JSON.stringify(input.field.options)}`] : []),
    "如能从来源中找到依据，同时返回 evidence 字段；没有依据时返回空字符串。",
    `辅助字段：${JSON.stringify(input.sourceFields)}`,
    `依赖字段结果：${JSON.stringify(input.dependencyResults)}`,
    protocol,
  ].join("\n");
  return [
    { role: "system", content: `你是结构化客服数据解析助手。只返回合法 JSON。${protocol}` },
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
