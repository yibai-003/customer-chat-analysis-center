import { z } from "zod";
import { ANALYSIS_EXECUTION_TYPES } from "../../shared/types";

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
  executionType: z.enum(ANALYSIS_EXECUTION_TYPES).optional(),
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
const sectionVersionSectionInput = sectionInput.extend({
  id,
  parentId: id.nullable(),
  outputSchema: z.array(output).max(200),
  sourceFields: z.array(safeName).max(100),
  sortOrder: z.number().int().min(0).max(100000),
  isEnabled: z.boolean(),
  imageEnabled: z.boolean(),
}).strict();
const sectionVersionFieldInput = fieldInput.extend({
  id,
  sectionId: id,
  prompt: z.string().max(20000),
  options,
  required: z.boolean(),
  imageEnabled: z.boolean(),
  dependsOn: z.array(safeName).max(50),
  sortOrder: z.number().int().min(0).max(100000),
  isEnabled: z.boolean(),
  executionType: z.enum(ANALYSIS_EXECUTION_TYPES),
  exportEnabled: z.boolean(),
  candidateLimit: z.number().int().min(1).max(100),
  knowledgeSyncEnabled: z.boolean(),
  knowledgeCaptureLimit: z.union([z.literal(1), z.literal(2)]),
}).strict();
const sectionVersionKnowledgeItemInput = z.object({
  id,
  knowledgeBaseId: id,
  pathKey: z.string().max(2000),
  values: z.record(z.string(), z.unknown()),
  searchText: z.string().max(100000),
  isEnabled: z.boolean(),
  sourceImportId: id.nullable(),
  sourceRowNumber: z.number().int().min(1).max(1048576).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
const sectionVersionKnowledgeBaseInput = z.object({
  id,
  sectionId: id,
  name: safeName,
  originalFilename: z.string().max(512),
  columns: knowledgeColumns,
  itemCount: z.number().int().min(0),
  isEnabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  items: z.array(sectionVersionKnowledgeItemInput).max(100000),
}).strict();
export const sectionConfigVersionPatchInput = z.object({
  sectionSnapshot: sectionVersionSectionInput.partial().optional(),
  fieldsSnapshot: z.array(sectionVersionFieldInput).max(200).optional(),
  exportSettings: z.object({
    rowMode: z.enum(["records", "screenshot_records"]).optional(),
    outputColumns: z.array(z.object({
      key: safeName,
      outputColumn: z.string().max(120).nullable(),
      source: z.enum([
        "field_result",
        "platform_name",
        "conversation_id",
        "reception_quality",
      ]).optional(),
      format: z.enum([
        "value",
        "reception_issue_names_csv",
        "reception_issue_dimensions_csv",
        "reception_issue_deductions_csv",
        "reception_total_deduction",
        "reception_has_d_level",
        "reception_chat_quotes",
        "reception_evidence_explanations",
        "reception_reasons",
        "reception_suggestions",
        "reception_grade",
        "reception_review_required",
        "reception_start_time",
        "reception_round_count",
      ]).optional(),
    }).strict()).max(200),
  }).strict().optional(),
  dependenciesSnapshot: z.array(z.object({
    key: safeName,
    dependsOn: z.array(safeName).max(50),
  }).strict()).max(200).optional(),
  knowledgeSnapshot: z.array(sectionVersionKnowledgeBaseInput).max(200).optional(),
  businessRules: z.record(z.string(), z.unknown()).optional(),
}).strict();
const receptionIssueRuleInput = z.object({
  id: safeName,
  name: safeName,
  dimension: safeName,
  scope: z.enum(["preSale", "afterSale"]),
  criterion: z.string().max(20000),
  deduction: z.number().min(0).max(100),
  forceD: z.boolean(),
  violationCount: z.number().int().min(0).max(100),
  priority: z.number().int().min(0).max(100000),
  suggestion: z.string().max(20000),
  applicableWhen: z.array(z.string().max(20000)).max(100),
  triggerWhen: z.array(z.string().max(20000)).max(100),
  exclusions: z.array(z.string().max(20000)).max(100),
  requiredEvidence: z.array(z.string().max(20000)).max(100),
  missingDataOutcome: z.enum(["not_applicable", "blocking_review", "informational"]),
}).strict();
export const receptionBusinessRulesInput = z.object({
  kind: z.literal("reception_quality"),
  scoreBase: z.number().min(0).max(1000),
  gradeThresholds: z.array(z.object({
    grade: z.enum(["A", "B", "C", "D"]),
    minScore: z.number().min(0).max(1000),
  }).strict()).length(4),
  forceDGrade: z.literal("D"),
  issues: z.array(receptionIssueRuleInput).min(1).max(200),
  importContract: z.object({
    imageColumn: safeName,
    resultColumns: z.array(safeName).min(1).max(200)
      .refine(fields => new Set(fields).size === fields.length, "结果区字段重复"),
    completeHistoricalResultRequiredColumns: z.array(safeName).min(1).max(200)
      .refine(fields => new Set(fields).size === fields.length, "完整历史结果必填字段重复"),
  }).strict(),
}).strict();
export function parseConfiguration<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`配置参数无效：${result.error.issues.slice(0, 3).map(issue => `${issue.path.join(".")} ${issue.message}`).join("；")}`);
  return result.data;
}
