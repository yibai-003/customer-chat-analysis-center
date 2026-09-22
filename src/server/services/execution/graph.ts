import { assertAnalysisActive } from "../analysis-cancellation";
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
  const availableSources = new Set([...sourceFields, ...Object.keys(initialContext)]);
  const byKey = new Map<string, AnalysisField>();
  for (const field of graphFields) {
    if (byKey.has(field.key)) throw new Error(`字段 Key 重复：${field.key}`);
    byKey.set(field.key, field);
  }
  for (const field of graphFields) {
    for (const dependency of field.dependsOn) {
      if (dependency === field.key) throw new Error(`字段不能依赖自身：${field.key}`);
      if (!byKey.has(dependency) && !availableSources.has(dependency)) {
        throw new Error(`依赖字段不存在：${field.key} -> ${dependency}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const orderedGraph: AnalysisField[] = [];
  const visit = (field: AnalysisField) => {
    if (visited.has(field.key)) return;
    if (visiting.has(field.key)) throw new Error(`循环依赖：${field.key}`);
    visiting.add(field.key);
    for (const dependency of field.dependsOn) {
      const dependencyField = byKey.get(dependency);
      if (dependencyField) visit(dependencyField);
    }
    visiting.delete(field.key);
    visited.add(field.key);
    orderedGraph.push(field);
  };
  const sortedFields: AnalysisField[] = [];
  for (const field of graphFields) {
    const index = sortedFields.findIndex((candidate) => candidate.sortOrder > field.sortOrder);
    if (index < 0) sortedFields.push(field);
    else sortedFields.splice(index, 0, field);
  }
  sortedFields.forEach(visit);
  const ordered = orderedGraph.filter((field) => selectedKeys.has(field.key));
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
