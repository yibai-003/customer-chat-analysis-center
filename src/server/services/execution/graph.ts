import { assertAnalysisActive } from "../analysis-cancellation";
import { topologicalFields } from "../field-config-service";
import type { AnalysisField } from "../../../shared/types";

export interface FieldExecutionState {
  status: "completed" | "failed" | "needs_review" | "skipped";
  result: Record<string, unknown>;
  errorMessage?: string;
}

interface FieldRunnerEnvelope {
  result: Record<string, unknown>;
  status: "completed" | "needs_review";
  errorMessage?: string;
}
type FieldRunnerResult = Record<string, unknown> | FieldRunnerEnvelope;

function isFieldRunnerEnvelope(value: FieldRunnerResult): value is FieldRunnerEnvelope {
  return typeof value === "object" && value !== null && "result" in value && "status" in value;
}

export async function executeFieldGraph(
  fields: AnalysisField[],
  runner: (field: AnalysisField, context: Record<string, unknown>) => Promise<FieldRunnerResult>,
  sourceFields: string[] = [],
  initialContext: Record<string, unknown> = {},
  graphFields: AnalysisField[] = fields,
) {
  const selectedKeys = new Set(fields.map((field) => field.key));
  const ordered = (topologicalFields(
    graphFields,
    [...new Set([...sourceFields, ...Object.keys(initialContext)])],
  ) as AnalysisField[]).filter((field) => selectedKeys.has(field.key));
  const states: Record<string, FieldExecutionState> = {};
  const context: Record<string, unknown> = { ...initialContext };
  for (const field of ordered) {
    assertAnalysisActive();
    const dependencyFailed = field.dependsOn.some((key) => states[key]?.status === "failed" || states[key]?.status === "skipped");
    if (dependencyFailed) {
      states[field.key] = { status: "skipped", result: {}, errorMessage: "依赖字段解析失败或已跳过" };
      continue;
    }
    try {
      const output = await runner(field, context);
      const envelope = isFieldRunnerEnvelope(output);
      const result = envelope ? output.result : output;
      const status = envelope ? output.status : "completed";
      states[field.key] = { status, result, errorMessage: envelope ? output.errorMessage : undefined };
      Object.assign(context, result);
    } catch (error) {
      assertAnalysisActive();
      states[field.key] = { status: "failed", result: {}, errorMessage: error instanceof Error ? error.message : "字段解析失败" };
    }
  }
  return states;
}
