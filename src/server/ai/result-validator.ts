import type { OutputField } from "../../shared/types";

export function validateAnalysisResult(raw: string, schema: OutputField[]) {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { /* handled below */ }
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, result: {}, error: "模型返回不是合法 JSON" };
  }
  const result = parsed as Record<string, unknown>;
  const missing = schema.filter((field) => field.required && (result[field.key] === undefined || result[field.key] === "")).map((field) => field.key);
  if (missing.length) return { valid: false, result, error: `缺少必填字段：${missing.join(", ")}` };
  const invalidType = schema.find((field) => {
    const value = result[field.key];
    if (value === undefined || value === null || value === "") return false;
    return field.type === "string" ? typeof value !== "string"
      : field.type === "number" ? typeof value !== "number" || Number.isNaN(value)
      : field.type === "object" ? typeof value !== "object" || Array.isArray(value)
      : typeof value !== "boolean";
  });
  if (invalidType) return { valid: false, result, error: `字段类型不匹配：${invalidType.key} 应为 ${invalidType.type}` };
  const invalidOption = schema.find((field) => {
    const value = result[field.key];
    return field.options?.length && value !== undefined && !field.options.includes(String(value));
  });
  if (invalidOption) return { valid: false, result, error: `字段可选值不匹配：${invalidOption.key}` };
  return { valid: true, result, error: null };
}
