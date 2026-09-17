import type { getRecord } from "../../db/repositories";
import {
  DEFAULT_EXECUTION_TYPE,
  type AnalysisExecutionType,
  type AnalysisField,
  type AnalysisFieldRun,
} from "../../../shared/types";

export type ExecutionRecord = NonNullable<ReturnType<typeof getRecord>>;

export interface FieldExecutionInput {
  recordId: string;
  sectionName: string;
  record: ExecutionRecord;
  field: AnalysisField;
  context: Record<string, unknown>;
  image: Buffer | null;
}

export interface FieldExecutionOutput {
  result: Record<string, unknown>;
  status: "completed" | "needs_review" | "failed";
  errorMessage?: string;
  run?: AnalysisFieldRun;
}

export interface FieldExecutionHandler {
  type: AnalysisExecutionType;
  run(input: FieldExecutionInput): Promise<FieldExecutionOutput>;
}

const handlers = new Map<AnalysisExecutionType, FieldExecutionHandler>();

export function registerFieldExecutionHandler(handler: FieldExecutionHandler) {
  handlers.set(handler.type, handler);
}

export function fieldExecutionHandler(type: AnalysisExecutionType | undefined): FieldExecutionHandler {
  const resolved = type ?? DEFAULT_EXECUTION_TYPE;
  const handler = handlers.get(resolved);
  if (!handler) throw new Error(`未注册的字段执行类型：${resolved}`);
  return handler;
}

export function registeredExecutionTypes(): AnalysisExecutionType[] {
  return [...handlers.keys()];
}
