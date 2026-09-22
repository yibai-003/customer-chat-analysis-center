import fs from "node:fs/promises";
import { assertAnalysisActive } from "./analysis-cancellation";
import { withModelBudget } from "../ai/model-budget";
import { withSingleAnalysisRun } from "./single-analysis-run";
import { assertJobSection, getRecord, updateRecord } from "../db/repositories";
import { createFieldRun, getFieldResultContextForFields } from "./field-run-service";
import { captureHotTopicQuestions } from "./knowledge/hot-topic-service";
import { isHotTopicField } from "../../shared/hot-topic";
import { dependencyValues } from "./execution/support";
import { executeFieldGraph, fieldExecutionHandler, type FieldExecutionOutput } from "./execution";
import {
  type AnalysisField,
  type AnalysisFieldRun,
  type SectionConfigVersion,
} from "../../shared/types";
import type { FieldExecutionState } from "./execution";
import { getJobSectionConfigVersion } from "./section-config-version-service";

export { executeFieldGraph } from "./execution";
export type { FieldExecutionState } from "./execution";

export interface FieldBatchProgress {
  total: number;
  completed: number;
  failed: number;
  needsReview: number;
  skipped: number;
}

async function runField(
  recordId: string,
  sectionName: string,
  record: NonNullable<ReturnType<typeof getRecord>>,
  field: AnalysisField,
  configVersion: SectionConfigVersion,
  context: Record<string, unknown>,
  image: Buffer | null,
): Promise<FieldExecutionOutput> {
  assertAnalysisActive();
  return withModelBudget(() => runFieldWithinBudget(
    recordId,
    sectionName,
    record,
    field,
    configVersion,
    context,
    image,
  ));
}

async function runFieldWithinBudget(
  recordId: string,
  sectionName: string,
  record: NonNullable<ReturnType<typeof getRecord>>,
  field: AnalysisField,
  configVersion: SectionConfigVersion,
  context: Record<string, unknown>,
  image: Buffer | null,
): Promise<FieldExecutionOutput> {
  if (isHotTopicField(field) && field.knowledgeSyncEnabled) {
    const run = await captureHotTopicQuestions({
      recordId,
      field,
      configVersion,
      dependencies: dependencyValues(field, record.sourceFields, context),
    });
    return { result: run.result, status: run.status === "completed" ? "completed" as const : run.status === "failed" ? "failed" as const : "needs_review" as const, errorMessage: run.errorMessage, run };
  }
  const handler = fieldExecutionHandler(field.executionType);
  return handler.run({ recordId, sectionName, record, field, configVersion, context, image });
}

export async function analyzeRecordFields(recordId: string, sectionId: string): Promise<FieldBatchProgress> {
  return withSingleAnalysisRun(
    recordId,
    sectionId,
    () => withModelBudget(() => analyzeRecordFieldsWithinRun(recordId, sectionId)),
  );
}

function latestRunsByField(record: NonNullable<ReturnType<typeof getRecord>>, sectionId: string) {
  const latest = new Map<string, (typeof record.fieldRuns)[number]>();
  for (const run of record.fieldRuns) {
    if (run.sectionId === sectionId && !latest.has(run.fieldId)) latest.set(run.fieldId, run);
  }
  return latest;
}

function descendantKeys(fields: AnalysisField[], startingKeys: Set<string>) {
  const selected = new Set(startingKeys);
  let changed = true;
  while (changed) {
    changed = false;
    for (const field of fields) {
      if (!selected.has(field.key) && field.dependsOn.some((key) => selected.has(key))) {
        selected.add(field.key);
        changed = true;
      }
    }
  }
  return selected;
}

function persistedState(run: NonNullable<ReturnType<typeof getRecord>>["fieldRuns"][number]): FieldExecutionState {
  return {
    status: run.status,
    result: run.result,
    errorMessage: run.errorMessage,
  };
}

function createSkippedRuns(
  recordId: string,
  fields: AnalysisField[],
  states: Record<string, FieldExecutionState>,
) {
  for (const field of fields) {
    const state = states[field.key];
    if (state?.status !== "skipped") continue;
    createFieldRun({
      recordId, fieldId: field.id, status: "skipped", result: {},
      dependencies: Object.fromEntries(field.dependsOn.map((key) => [key, states[key]?.result])),
      promptSnapshot: field.prompt, fieldSnapshot: field,
      modelConfigSnapshot: {},
      errorMessage: state.errorMessage,
    });
  }
}

function requiresImage(fields: AnalysisField[]) {
  return fields.some((field) => field.imageEnabled);
}

async function analyzeRecordFieldsWithinRun(recordId: string, sectionId: string): Promise<FieldBatchProgress> {
  const record = getRecord(recordId);
  if (!record) throw new Error("记录不存在");
  assertJobSection(record.jobId, sectionId);
  const version = getJobSectionConfigVersion(record.jobId);
  if (!version || version.sectionId !== sectionId) throw new Error("任务未绑定有效的配置版本");
  const section = version.sectionSnapshot;
  const fields = version.fieldsSnapshot.filter((field) => field.isEnabled);
  const latestRuns = latestRunsByField(record, sectionId);
  const rerunKeys = record.status !== "completed" && latestRuns.size > 0
    ? descendantKeys(fields, new Set(fields
      .filter((field) => latestRuns.get(field.id)?.status !== "completed")
      .map((field) => field.key)))
    : new Set(fields.map((field) => field.key));
  const fieldsToRun = fields.filter((field) => rerunKeys.has(field.key));
  const retainedStates = Object.fromEntries(fields
    .filter((field) => !rerunKeys.has(field.key) && latestRuns.get(field.id)?.status === "completed")
    .map((field) => [field.key, persistedState(latestRuns.get(field.id)!)]));
  const initialContext = Object.assign({}, ...Object.values(retainedStates).map((state) => state.result));
  const image = requiresImage(fieldsToRun) ? await fs.readFile(record.imagePath) : null;
  updateRecord(recordId, { status: "processing" });
  const rerunStates = await executeFieldGraph(fieldsToRun, async (field, context) => {
    const run = await runField(recordId, section.name, record, field, version, context, image);
    if (run.status === "failed") throw new Error(run.errorMessage);
    return { result: run.result, status: run.status, errorMessage: run.errorMessage };
  }, section.sourceFields ?? [], initialContext, fields);
  const states = { ...retainedStates, ...rerunStates };
  createSkippedRuns(recordId, fieldsToRun, states);
  const currentStates = Object.values(states);
  const completed = currentStates.filter((state) => state.status === "completed").length;
  const failed = currentStates.filter((state) => state.status === "failed").length;
  const needsReview = currentStates.filter((state) => state.status === "needs_review").length;
  const skipped = currentStates.filter((state) => state.status === "skipped").length;
  const status = failed > 0 ? "failed" : needsReview > 0 || skipped > 0 ? "needs_review" : "completed";
  updateRecord(recordId, { status, reviewStatus: status === "completed" ? "pending" : "needs_review" });
  return { total: fields.length, completed, failed, needsReview, skipped };
}

export async function analyzeField(recordId: string, sectionId: string, fieldKey: string): Promise<AnalysisFieldRun> {
  return withSingleAnalysisRun(
    recordId,
    sectionId,
    () => withModelBudget(() => analyzeFieldWithinRun(recordId, sectionId, fieldKey)),
  );
}

async function analyzeFieldWithinRun(recordId: string, sectionId: string, fieldKey: string): Promise<AnalysisFieldRun> {
  const record = getRecord(recordId);
  if (!record) throw new Error("记录不存在");
  assertJobSection(record.jobId, sectionId);
  const version = getJobSectionConfigVersion(record.jobId);
  if (!version || version.sectionId !== sectionId) throw new Error("任务未绑定有效的配置版本");
  const section = version.sectionSnapshot;
  const fields = version.fieldsSnapshot.filter((item) => item.isEnabled);
  const field = fields.find((item) => item.key === fieldKey);
  if (!field) throw new Error("配置版本中不存在该字段");
  const keysToRun = descendantKeys(fields, new Set([field.key]));
  const fieldsToRun = fields.filter((item) => keysToRun.has(item.key));
  const image = requiresImage(fieldsToRun) ? await fs.readFile(record.imagePath) : null;
  const reusableKeys = fields.filter((item) => !keysToRun.has(item.key)).map((item) => item.key);
  const context = getFieldResultContextForFields(
    recordId,
    fields.filter((item) => reusableKeys.includes(item.key)),
  );
  const missing = field.dependsOn.filter((key) => context[key] === undefined && record.sourceFields[key] === undefined);
  if (missing.length) throw new Error(`依赖字段未完成：${missing.join(", ")}`);
  const executedStates = await executeFieldGraph(fieldsToRun, async (item, currentContext) => {
    const run = await runField(recordId, section.name, record, item, version, currentContext, image);
    if (run.status === "failed") throw new Error(run.errorMessage);
    return { result: run.result, status: run.status, errorMessage: run.errorMessage };
  }, section.sourceFields ?? [], context, fields);
  createSkippedRuns(recordId, fieldsToRun, executedStates);
  const latest = getRecord(recordId)!;
  const latestRuns = latestRunsByField(latest, sectionId);
  const statuses = fields.map((item) => latestRuns.get(item.id)?.status ?? "pending");
  const status = statuses.includes("failed") ? "failed" : statuses.includes("needs_review") || statuses.includes("skipped") ? "needs_review"
    : statuses.includes("pending") ? "pending" : "completed";
  updateRecord(recordId, { status, reviewStatus: status === "failed" || status === "needs_review" ? "needs_review" : "pending" });
  return latestRuns.get(field.id)!;
}

export async function retryField(recordId: string, sectionId: string, fieldKey: string) {
  return analyzeField(recordId, sectionId, fieldKey);
}
