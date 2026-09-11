import fs from "node:fs/promises";
import { getModelsForPurpose } from "./model-config-service";
import { assertJobSection, getRecord, getSection, updateJobSection, updateRecord } from "../db/repositories";
import { listFields, topologicalFields } from "./field-config-service";
import { buildFieldMessages } from "../ai/field-prompt-builder";
import { callVisionModel } from "../ai/openai-compatible-client";
import { classifyModelError } from "../ai/openai-compatible-client";
import { validateAnalysisResult } from "../ai/result-validator";
import { createFieldRun, getFieldResultContext } from "./field-run-service";
import { matchKnowledgeItem } from "./knowledge/knowledge-match-service";
import { extractKnowledgeValue } from "./knowledge/knowledge-extract-service";
import type { AnalysisField, AnalysisFieldRun } from "../../shared/types";

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
) {
  const ordered = topologicalFields(fields, sourceFields) as AnalysisField[];
  const states: Record<string, FieldExecutionState> = {};
  const context: Record<string, unknown> = {};
  for (const field of ordered) {
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
      states[field.key] = { status: "failed", result: {}, errorMessage: error instanceof Error ? error.message : "字段解析失败" };
    }
  }
  return states;
}

export interface FieldBatchProgress {
  total: number;
  completed: number;
  failed: number;
  needsReview: number;
  skipped: number;
}

function imageDataUrl(imagePath: string, buffer: Buffer) {
  const ext = imagePath.split(".").pop() ?? "png";
  return `data:image/${ext};base64,${buffer.toString("base64")}`;
}

function dependencyValues(
  field: AnalysisField,
  sourceFields: Record<string, string>,
  context: Record<string, unknown>,
) {
  return Object.fromEntries(field.dependsOn.map((key) => [key, sourceFields[key] ?? context[key]]));
}

async function runAiField(
  recordId: string,
  sectionName: string,
  record: NonNullable<ReturnType<typeof getRecord>>,
  field: AnalysisField,
  context: Record<string, unknown>,
  image: Buffer | null,
) {
  const dependencies = dependencyValues(field, record.sourceFields, context);
  const started = Date.now();
  let model: Awaited<ReturnType<typeof getModelsForPurpose>>[number] | undefined;
  try {
    const models = getModelsForPurpose(field.imageEnabled ? "vision" : "text");
    if (!models.length) throw new Error("请先配置并启用默认模型");
    const messages = buildFieldMessages({
      field,
      sectionName,
      sourceFields: record.sourceFields,
      dependencyResults: dependencies,
      imageDataUrl: field.imageEnabled && image ? imageDataUrl(record.imagePath, image) : "",
    });
    let response: Awaited<ReturnType<typeof callVisionModel>> | undefined;
    let lastError: unknown;
    for (const candidate of models) {
      try {
        if (field.imageEnabled && !candidate.supportsVision) throw new Error("当前模型不支持图片解析");
        response = await callVisionModel(candidate, messages);
        model = candidate;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!response || !model) throw lastError ?? new Error("模型请求失败");
    const checked = validateAnalysisResult(response.content, [{
      key: field.key, label: field.label, type: field.type, required: field.required,
      options: field.options,
    }]);
    const status = checked.valid ? "completed" : "needs_review";
    const run = createFieldRun({
      recordId, fieldId: field.id, status, result: checked.result,
      evidence: typeof checked.result.evidence === "string" ? checked.result.evidence : undefined,
      dependencies,
      promptSnapshot: field.prompt, fieldSnapshot: field,
      modelConfigSnapshot: { name: model.name, model: model.model, baseUrl: model.baseUrl },
      rawResponse: response.raw, errorMessage: checked.error ?? undefined,
      durationMs: Date.now() - started, usage: response.usage,
    });
    return { result: checked.result, status, errorMessage: checked.error ?? undefined, run };
  } catch (error) {
    const message = classifyModelError(error).message;
    const run = createFieldRun({
      recordId, fieldId: field.id, status: "failed", result: {},
      dependencies,
      promptSnapshot: field.prompt, fieldSnapshot: field,
      modelConfigSnapshot: model ? { name: model.name, model: model.model } : {},
      errorMessage: message, durationMs: Date.now() - started,
    });
    return { result: {}, status: "failed" as const, errorMessage: message, run };
  }
}

async function runKnowledgeMatch(
  recordId: string,
  sectionName: string,
  record: NonNullable<ReturnType<typeof getRecord>>,
  field: AnalysisField,
  context: Record<string, unknown>,
) {
  const dependencies = dependencyValues(field, record.sourceFields, context);
  const started = Date.now();
  try {
    const matched = await matchKnowledgeItem({
      recordId,
      field,
      sectionName,
      dependencies,
    });
    const run = createFieldRun({
      recordId,
      fieldId: field.id,
      status: matched.status,
      result: matched.result,
      dependencies,
      promptSnapshot: field.prompt,
      fieldSnapshot: field,
      modelConfigSnapshot: { purpose: "text" },
      errorMessage: matched.errorMessage,
      durationMs: Date.now() - started,
    });
    return {
      result: matched.result,
      status: matched.status,
      errorMessage: matched.errorMessage,
      run,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "知识匹配失败";
    const run = createFieldRun({
      recordId,
      fieldId: field.id,
      status: "failed",
      result: {},
      dependencies,
      promptSnapshot: field.prompt,
      fieldSnapshot: field,
      modelConfigSnapshot: { purpose: "text" },
      errorMessage: message,
      durationMs: Date.now() - started,
    });
    return { result: {}, status: "failed" as const, errorMessage: message, run };
  }
}

function runKnowledgeExtract(
  recordId: string,
  record: NonNullable<ReturnType<typeof getRecord>>,
  field: AnalysisField,
  context: Record<string, unknown>,
) {
  const dependencies = dependencyValues(field, record.sourceFields, context);
  const started = Date.now();
  try {
    const result = extractKnowledgeValue({
      recordId,
      sectionId: field.sectionId,
      matchFieldKey: field.matchFieldKey!,
      matchValue: typeof context[field.matchFieldKey!] === "string"
        ? context[field.matchFieldKey!] as string
        : "",
      knowledgeColumn: field.knowledgeColumn!,
      outputKey: field.key,
    });
    const run = createFieldRun({
      recordId,
      fieldId: field.id,
      status: "completed",
      result,
      dependencies,
      promptSnapshot: field.prompt,
      fieldSnapshot: field,
      modelConfigSnapshot: {},
      durationMs: Date.now() - started,
    });
    return { result, status: "completed" as const, run };
  } catch (error) {
    const message = error instanceof Error ? error.message : "知识提取失败";
    const run = createFieldRun({
      recordId,
      fieldId: field.id,
      status: "failed",
      result: {},
      dependencies,
      promptSnapshot: field.prompt,
      fieldSnapshot: field,
      modelConfigSnapshot: {},
      errorMessage: message,
      durationMs: Date.now() - started,
    });
    return { result: {}, status: "failed" as const, errorMessage: message, run };
  }
}

async function runField(
  recordId: string,
  sectionName: string,
  record: NonNullable<ReturnType<typeof getRecord>>,
  field: AnalysisField,
  context: Record<string, unknown>,
  image: Buffer | null,
) {
  switch (field.executionType ?? "ai") {
    case "knowledge_match":
      return runKnowledgeMatch(recordId, sectionName, record, field, context);
    case "knowledge_extract":
      return runKnowledgeExtract(recordId, record, field, context);
    default:
      return runAiField(recordId, sectionName, record, field, context, image);
  }
}

export async function analyzeRecordFields(recordId: string, sectionId: string): Promise<FieldBatchProgress> {
  const record = getRecord(recordId);
  const section = getSection(sectionId);
  if (!record || !section) throw new Error("记录或解析板块不存在");
  assertJobSection(record.jobId, section.id);
  updateJobSection(record.jobId, { id: section.id, name: section.name });
  const fields = listFields(sectionId).filter((field) => field.isEnabled);
  const image = fields.some((field) => (field.executionType ?? "ai") === "ai" && field.imageEnabled)
    ? await fs.readFile(record.imagePath)
    : null;
  updateRecord(recordId, { status: "processing" });
  const states = await executeFieldGraph(fields, async (field, context) => {
    const run = await runField(recordId, section.name, record, field, context, image);
    if (run.status === "failed") throw new Error(run.errorMessage);
    return { result: run.result, status: run.status, errorMessage: run.errorMessage };
  }, section.sourceFields ?? []);
  for (const field of fields) {
    const state = states[field.key];
    if (state.status === "skipped") {
      createFieldRun({
        recordId, fieldId: field.id, status: "skipped", result: {},
        dependencies: Object.fromEntries(field.dependsOn.map((key) => [key, states[key]?.result])),
        promptSnapshot: field.prompt, fieldSnapshot: field,
        modelConfigSnapshot: {},
        errorMessage: state.errorMessage,
      });
    }
  }
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
  const record = getRecord(recordId);
  const section = getSection(sectionId);
  const field = listFields(sectionId).find((item) => item.key === fieldKey && item.isEnabled);
  if (!record || !section || !field) throw new Error("记录、板块或字段不存在");
  assertJobSection(record.jobId, section.id);
  updateJobSection(record.jobId, { id: section.id, name: section.name });
  const image = (field.executionType ?? "ai") === "ai" && field.imageEnabled
    ? await fs.readFile(record.imagePath)
    : null;
  const context = getFieldResultContext(recordId, field.dependsOn, sectionId);
  const dependencyValues = Object.fromEntries(field.dependsOn.map((key) => [key, record.sourceFields[key] ?? context[key]]));
  const missing = field.dependsOn.filter((key) => dependencyValues[key] === undefined);
  if (missing.length) throw new Error(`依赖字段未完成：${missing.join(", ")}`);
  const run = await runField(recordId, section.name, record, field, dependencyValues, image);
  updateRecord(recordId, { status: run.status === "failed" ? "failed" : run.status === "needs_review" ? "needs_review" : "completed", reviewStatus: run.status === "completed" ? "pending" : "needs_review" });
  return run.run;
}

export async function retryField(recordId: string, sectionId: string, fieldKey: string) {
  return analyzeField(recordId, sectionId, fieldKey);
}
