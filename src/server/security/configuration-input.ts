import { z } from "zod";

const safeName = z.string().min(1).max(120).refine(value => Boolean(value.trim()) && !["__proto__", "prototype", "constructor"].includes(value) && !/[\u0000-\u001f]/.test(value), "名称包含保留字或控制字符");
const id = z.string().min(1).max(200);
const kind = z.enum(["string", "number", "boolean", "object"]);
const options = z.array(z.string().max(200)).max(200);
const output = z.object({ key: safeName, label: safeName, type: kind, required: z.boolean().optional(), options: options.optional() });
export const fieldInput = z.object({
  id: id.optional(), sectionId: id, key: safeName, label: safeName, type: kind,
  prompt: z.string().max(20000).optional(), options: options.optional(), outputColumn: z.string().max(120).optional(),
  required: z.boolean().optional(), imageEnabled: z.boolean().optional(), isEnabled: z.boolean().optional(), exportEnabled: z.boolean().optional(),
  dependsOn: z.array(safeName).max(50).optional(), sortOrder: z.number().int().min(0).max(100000).optional(),
  executionType: z.enum([
    "ai",
    "knowledge_match",
    "knowledge_extract",
    "lost_deal_attribution",
    "lost_deal_derive",
    "lost_deal_script",
    "reception_quality_analysis",
    "reception_quality_derive",
  ]).optional(),
  knowledgeBaseId: z.string().max(200).optional(), matchFieldKey: z.string().max(120).optional(), knowledgeColumn: z.string().max(120).optional(),
  candidateLimit: z.number().int().min(5).max(30).optional(), knowledgeSyncEnabled: z.boolean().optional(),
  knowledgeCaptureLimit: z.union([z.literal(1), z.literal(2)]).optional(),
});
export const sectionInput = z.object({
  id: id.optional(), parentId: id.nullable().optional(), name: safeName, prompt: z.string().max(20000),
  outputSchema: z.array(output).max(200).refine(fields => new Set(fields.map(f => f.key)).size === fields.length, "输出字段 Key 重复").optional(),
  sourceFields: z.array(safeName).max(100).optional(), sortOrder: z.number().int().min(0).max(100000).optional(),
  isEnabled: z.boolean().optional(), imageEnabled: z.boolean().optional(),
});
export const knowledgeColumns = z.array(z.object({
  name: safeName,
  roles: z.array(z.enum(["result", "search", "keyword", "description", "positive_example", "negative_example", "metadata"])).min(1).max(7)
    .refine(roles => new Set(roles).size === roles.length, "列角色重复"),
  requiredParent: z.string().max(120).optional(),
})).max(200).superRefine((columns, ctx) => {
  if (new Set(columns.map(c => c.name)).size !== columns.length) ctx.addIssue({ code: "custom", message: "列名重复" });
  const mapping = new Map(columns.map(c => [c.name, c.requiredParent]));
  for (const column of columns) {
    const seen = new Set([column.name]); let parent = column.requiredParent;
    while (parent) {
      if (seen.has(parent) || !mapping.has(parent)) { ctx.addIssue({ code: "custom", message: "父列不存在或存在循环" }); break; }
      seen.add(parent); parent = mapping.get(parent);
    }
  }
});
export const knowledgeBaseInput = z.object({ id: id.optional(), sectionId: id, name: safeName, originalFilename: z.string().max(512), columns: knowledgeColumns.min(1), isEnabled: z.boolean() });
export const knowledgeItemInput = z.object({ id: id.optional(), knowledgeBaseId: id,
  values: z.record(safeName, z.string().max(32767)).refine(values => Object.keys(values).length <= 200, "条目列数过多"),
  isEnabled: z.boolean(), sourceRowNumber: z.number().int().min(1).max(1048576).optional(),
});
export function parseConfiguration<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`配置参数无效：${result.error.issues.slice(0, 3).map(issue => `${issue.path.join(".")} ${issue.message}`).join("；")}`);
  return result.data;
}
