import fs from "node:fs/promises";
import { db } from "../db/client";
import { assertAnalysisActive } from "./analysis-cancellation";
import { withModelBudget } from "../ai/model-budget";
import { withSingleAnalysisRun } from "./single-analysis-run";
import { assertJobSection, getRecord, getSection, updateJobSection, updateRecord } from "../db/repositories";
import { listFields, topologicalFields } from "./field-config-service";
import { buildFieldMessages } from "../ai/field-prompt-builder";
import { classifyModelError } from "../ai/openai-compatible-client";
import { validateFieldResult } from "../ai/result-validator";
import { createFieldRun, getFieldResultContext } from "./field-run-service";
import { callModelPool, ModelPoolError } from "./model-pool-service";
import { matchKnowledgeItem } from "./knowledge/knowledge-match-service";
import { extractKnowledgeValue } from "./knowledge/knowledge-extract-service";
import { captureHotTopicQuestions } from "./knowledge/hot-topic-service";
import { isHotTopicField } from "../../shared/hot-topic";
import {
  attributionFromContext,
  buildLostDealAttributionMessages,
  deriveLostDealFields,
  loadLostDealKnowledgeCandidates,
  parseLostDealAttribution,
} from "./lost-deal-attribution";
import { buildLostDealScriptSuggestion } from "./lost-deal-script-rules";
import { replaceLostDealReasonLinks } from "./lost-deal-capture";
import {
  buildReceptionQualityMessages,
  deriveReceptionQualityFields,
  parseReceptionQuality,
  receptionQualityFromContext,
} from "./reception-quality";
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
  return Object.fromEntries(field.dependsOn.map((key) => [key, context[key] ?? sourceFields[key]]));
}

function routedModelSnapshot(routed: Awaited<ReturnType<typeof callModelPool>>) {
  return {
    id: routed.model.id,
    name: routed.model.name,
    model: routed.model.model,
    purpose: routed.model.purpose,
    attempts: routed.attempts,
  };
}

function failedRouteSnapshot(error: unknown) {
  if (!(error instanceof ModelPoolError)) return {};
  const lastAttempt = error.attempts.at(-1);
  return {
    ...(lastAttempt ? {
      id: lastAttempt.modelConfigId,
      model: lastAttempt.model,
    } : {}),
    attempts: error.attempts,
  };
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
  let routed: Awaited<ReturnType<typeof callModelPool>> | undefined;
  try {
    const messages = buildFieldMessages({
      field,
      sectionName,
      sourceFields: record.sourceFields,
      dependencyResults: dependencies,
      imageDataUrl: field.imageEnabled && image ? imageDataUrl(record.imagePath, image) : "",
    });
    routed = await callModelPool(messages, {
      purpose: field.imageEnabled ? "vision" : "text",
      recordId,
      fieldId: field.id,
      operation: field.executionType ?? "ai",
    });
    assertAnalysisActive();
    const checked = validateFieldResult(routed.content, field);
    const status = checked.valid ? "completed" : "needs_review";
    const run = createFieldRun({
      recordId, fieldId: field.id, status, result: checked.result,
      evidence: typeof checked.result.evidence === "string" ? checked.result.evidence : undefined,
      dependencies,
      promptSnapshot: field.prompt, fieldSnapshot: field,
      modelConfigSnapshot: routedModelSnapshot(routed),
      rawResponse: routed.raw, errorMessage: checked.error ?? undefined,
      durationMs: Date.now() - started, usage: routed.usage,
    });
    return { result: checked.result, status, errorMessage: checked.error ?? undefined, run };
  } catch (error) {
    assertAnalysisActive();
    const message = classifyModelError(error).message;
    const run = createFieldRun({
      recordId, fieldId: field.id, status: "failed", result: {},
      dependencies,
      promptSnapshot: field.prompt, fieldSnapshot: field,
      modelConfigSnapshot: routed ? routedModelSnapshot(routed) : failedRouteSnapshot(error),
      rawResponse: routed?.raw,
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
    assertAnalysisActive();
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

async function runLostDealAttribution(
  recordId: string,
  record: NonNullable<ReturnType<typeof getRecord>>,
  field: AnalysisField,
  context: Record<string, unknown>,
) {
  const dependencies = dependencyValues(field, record.sourceFields, context);
  const started = Date.now();
  let routed: Awaited<ReturnType<typeof callModelPool>> | undefined;
  let invalidResponse: string | undefined;
  try {
    const candidates = loadLostDealKnowledgeCandidates(field);
    if (!candidates.customerReasons.length || !candidates.serviceReasons.length) {
      throw new Error("未成交原因知识库尚未初始化或没有启用条目");
    }
    const summary = typeof dependencies["截图内容总结"] === "string"
      ? dependencies["截图内容总结"] as string
      : "";
    const messages = buildLostDealAttributionMessages({
      field,
      summary,
      sourceFields: record.sourceFields,
      candidates,
    });
    const parseContext = {
      summary,
      sourceFields: record.sourceFields,
    };
    routed = await callModelPool(messages, {
      purpose: "text",
      recordId,
      fieldId: field.id,
      operation: field.executionType ?? "lost_deal_attribution",
      validate: (content) => {
        invalidResponse = content;
        try {
          parseLostDealAttribution(content, candidates, parseContext);
          invalidResponse = undefined;
          return { valid: true };
        } catch {
          return { valid: false };
        }
      },
    });
    assertAnalysisActive();
    const attribution = parseLostDealAttribution(routed.content, candidates, parseContext);
    const result = { [field.key]: attribution };
    const status = attribution.reviewRequired ? "needs_review" as const : "completed" as const;
    const errorMessage = attribution.reviewRequired ? "归因证据不足或置信度偏低，请人工复核" : undefined;
    const selectedRoute = routed;
    const run = db.transaction(() => {
      const created = createFieldRun({
      recordId,
      fieldId: field.id,
      status,
      result,
      evidence: attribution.evidence.join("\n"),
      dependencies,
      promptSnapshot: field.prompt,
      fieldSnapshot: field,
      modelConfigSnapshot: routedModelSnapshot(selectedRoute),
      rawResponse: selectedRoute.raw,
      errorMessage,
      durationMs: Date.now() - started,
      usage: selectedRoute.usage,
      });
      replaceLostDealReasonLinks(recordId, field.id, attribution, Boolean(field.knowledgeSyncEnabled));
      return created;
    })();
    return { result, status, errorMessage, run };
  } catch (error) {
    assertAnalysisActive();
    const message = classifyModelError(error).message;
    const run = createFieldRun({
      recordId,
      fieldId: field.id,
      status: "failed",
      result: {},
      dependencies,
      promptSnapshot: field.prompt,
      fieldSnapshot: field,
      modelConfigSnapshot: routed ? routedModelSnapshot(routed) : failedRouteSnapshot(error),
      rawResponse: routed?.raw ?? invalidResponse,
      errorMessage: message,
      durationMs: Date.now() - started,
    });
    return { result: {}, status: "failed" as const, errorMessage: message, run };
  }
}

function runLostDealDerived(
  recordId: string,
  record: NonNullable<ReturnType<typeof getRecord>>,
  field: AnalysisField,
  context: Record<string, unknown>,
) {
  const dependencies = dependencyValues(field, record.sourceFields, context);
  const started = Date.now();
  const attribution = attributionFromContext(context);
  const derived = deriveLostDealFields(attribution);
  const result = { [field.key]: derived[field.key] ?? "" };
  const run = createFieldRun({
    recordId,
    fieldId: field.id,
    status: attribution.reviewRequired ? "needs_review" : "completed",
    result,
    evidence: attribution.evidence.join("\n"),
    dependencies,
    promptSnapshot: field.prompt,
    fieldSnapshot: field,
    modelConfigSnapshot: {},
    durationMs: Date.now() - started,
  });
  return {
    result,
    status: attribution.reviewRequired ? "needs_review" as const : "completed" as const,
    errorMessage: attribution.reviewRequired ? "归因证据不足或置信度偏低，请人工复核" : undefined,
    run,
  };
}

function runLostDealScript(
  recordId: string,
  record: NonNullable<ReturnType<typeof getRecord>>,
  field: AnalysisField,
  context: Record<string, unknown>,
) {
  const dependencies = dependencyValues(field, record.sourceFields, context);
  const started = Date.now();
  const attribution = attributionFromContext(context);
  const result = {
    [field.key]: buildLostDealScriptSuggestion({
      customerReasons: attribution.customerReasons.map((item) => item.name).filter((name) => name !== "待复核"),
      serviceReasons: attribution.serviceReasons.map((item) => item.name).filter((name) => name !== "待复核"),
      evidence: attribution.evidence,
    }),
  };
  const run = createFieldRun({
    recordId,
    fieldId: field.id,
    status: attribution.reviewRequired ? "needs_review" : "completed",
    result,
    evidence: attribution.evidence.join("\n"),
    dependencies,
    promptSnapshot: field.prompt,
    fieldSnapshot: field,
    modelConfigSnapshot: { strategy: "local_rules" },
    durationMs: Date.now() - started,
  });
  return {
    result,
    status: attribution.reviewRequired ? "needs_review" as const : "completed" as const,
    errorMessage: attribution.reviewRequired ? "归因证据不足或置信度偏低，请人工复核" : undefined,
    run,
  };
}

async function runReceptionQualityAnalysis(
  recordId: string,
  record: NonNullable<ReturnType<typeof getRecord>>,
  field: AnalysisField,
  context: Record<string, unknown>,
) {
  const dependencies = dependencyValues(field, record.sourceFields, context);
  const started = Date.now();
  let routed: Awaited<ReturnType<typeof callModelPool>> | undefined;
  let invalidResponse: string | undefined;
  try {
    const messages = buildReceptionQualityMessages({
      field,
      screenshotFacts: dependencies["截图内容总结"],
      sourceFields: record.sourceFields,
    });
    const parseOptions = {
      screenshotFacts: dependencies["截图内容总结"],
    };
    routed = await callModelPool(messages, {
      purpose: "text",
      recordId,
      fieldId: field.id,
      operation: field.executionType ?? "reception_quality_analysis",
      validate: (content) => {
        invalidResponse = content;
        try {
          parseReceptionQuality(content, field.key, parseOptions);
          invalidResponse = undefined;
          return { valid: true };
        } catch {
          return { valid: false };
        }
      },
    });
    assertAnalysisActive();
    const quality = parseReceptionQuality(routed.content, field.key, parseOptions);
    const result = { [field.key]: quality };
    const status = quality.reviewRequired ? "needs_review" as const : "completed" as const;
    const errorMessage = quality.reviewRequired ? "质检场景或部分项目证据不足，请人工复核" : undefined;
    const evidence = [...quality.preSaleIssues, ...quality.afterSaleIssues].map((issue) => issue.evidence).join("\n");
    const run = createFieldRun({
      recordId,
      fieldId: field.id,
      status,
      result,
      evidence,
      dependencies,
      promptSnapshot: field.prompt,
      fieldSnapshot: field,
      modelConfigSnapshot: routedModelSnapshot(routed),
      rawResponse: routed.raw,
      errorMessage,
      durationMs: Date.now() - started,
      usage: routed.usage,
    });
    return { result, status, errorMessage, run };
  } catch (error) {
    assertAnalysisActive();
    const message = classifyModelError(error).message;
    const run = createFieldRun({
      recordId,
      fieldId: field.id,
      status: "failed",
      result: {},
      dependencies,
      promptSnapshot: field.prompt,
      fieldSnapshot: field,
      modelConfigSnapshot: routed ? routedModelSnapshot(routed) : failedRouteSnapshot(error),
      rawResponse: routed?.raw ?? invalidResponse,
      errorMessage: message,
      durationMs: Date.now() - started,
    });
    return { result: {}, status: "failed" as const, errorMessage: message, run };
  }
}

function runReceptionQualityDerived(
  recordId: string,
  record: NonNullable<ReturnType<typeof getRecord>>,
  field: AnalysisField,
  context: Record<string, unknown>,
) {
  const dependencies = dependencyValues(field, record.sourceFields, context);
  const started = Date.now();
  const quality = receptionQualityFromContext(context);
  const result = { [field.key]: deriveReceptionQualityFields(quality)[field.key] ?? "" };
  const status = quality.reviewRequired ? "needs_review" as const : "completed" as const;
  const errorMessage = quality.reviewRequired ? "质检场景或部分项目证据不足，请人工复核" : undefined;
  const run = createFieldRun({
    recordId,
    fieldId: field.id,
    status,
    result,
    evidence: [...quality.preSaleIssues, ...quality.afterSaleIssues].map((issue) => issue.evidence).join("\n"),
    dependencies,
    promptSnapshot: field.prompt,
    fieldSnapshot: field,
    modelConfigSnapshot: { strategy: "local_rules" },
    errorMessage,
    durationMs: Date.now() - started,
  });
  return { result, status, errorMessage, run };
}

async function runField(
  recordId: string,
  sectionName: string,
  record: NonNullable<ReturnType<typeof getRecord>>,
  field: AnalysisField,
  context: Record<string, unknown>,
  image: Buffer | null,
) {
  assertAnalysisActive();
  return withModelBudget(() => runFieldWithinBudget(recordId, sectionName, record, field, context, image));
}

async function runFieldWithinBudget(
  recordId: string,
  sectionName: string,
  record: NonNullable<ReturnType<typeof getRecord>>,
  field: AnalysisField,
  context: Record<string, unknown>,
  image: Buffer | null,
) {
  if (isHotTopicField(field) && field.knowledgeSyncEnabled) {
    const run = await captureHotTopicQuestions({ recordId, field, dependencies: dependencyValues(field, record.sourceFields, context) });
    return { result: run.result, status: run.status === "completed" ? "completed" as const : run.status === "failed" ? "failed" as const : "needs_review" as const, errorMessage: run.errorMessage, run };
  }
  switch (field.executionType ?? "ai") {
    case "knowledge_match":
      return runKnowledgeMatch(recordId, sectionName, record, field, context);
    case "knowledge_extract":
      return runKnowledgeExtract(recordId, record, field, context);
    case "lost_deal_attribution":
      return runLostDealAttribution(recordId, record, field, context);
    case "lost_deal_derive":
      return runLostDealDerived(recordId, record, field, context);
    case "lost_deal_script":
      return runLostDealScript(recordId, record, field, context);
    case "reception_quality_analysis":
      return runReceptionQualityAnalysis(recordId, record, field, context);
    case "reception_quality_derive":
      return runReceptionQualityDerived(recordId, record, field, context);
    default:
      return runAiField(recordId, sectionName, record, field, context, image);
  }
}

export async function analyzeRecordFields(recordId: string, sectionId: string): Promise<FieldBatchProgress> {
  return withSingleAnalysisRun(
    recordId,
    sectionId,
    () => withModelBudget(() => analyzeRecordFieldsWithinRun(recordId, sectionId), { requests: 4 }),
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

async function analyzeRecordFieldsWithinRun(recordId: string, sectionId: string): Promise<FieldBatchProgress> {
  const record = getRecord(recordId);
  const section = getSection(sectionId);
  if (!record || !section) throw new Error("记录或解析板块不存在");
  assertJobSection(record.jobId, section.id);
  updateJobSection(record.jobId, { id: section.id, name: section.name });
  const fields = listFields(sectionId).filter((field) => field.isEnabled);
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
  const image = fieldsToRun.some((field) => (field.executionType ?? "ai") === "ai" && field.imageEnabled)
    ? await fs.readFile(record.imagePath)
    : null;
  updateRecord(recordId, { status: "processing" });
  const rerunStates = await executeFieldGraph(fieldsToRun, async (field, context) => {
    const run = await runField(recordId, section.name, record, field, context, image);
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
    () => withModelBudget(() => analyzeFieldWithinRun(recordId, sectionId, fieldKey), { requests: 4 }),
  );
}

async function analyzeFieldWithinRun(recordId: string, sectionId: string, fieldKey: string): Promise<AnalysisFieldRun> {
  const record = getRecord(recordId);
  const section = getSection(sectionId);
  const fields = listFields(sectionId).filter((item) => item.isEnabled);
  const field = fields.find((item) => item.key === fieldKey);
  if (!record || !section || !field) throw new Error("记录、板块或字段不存在");
  assertJobSection(record.jobId, section.id);
  updateJobSection(record.jobId, { id: section.id, name: section.name });
  const keysToRun = descendantKeys(fields, new Set([field.key]));
  const fieldsToRun = fields.filter((item) => keysToRun.has(item.key));
  const image = fieldsToRun.some((item) => (item.executionType ?? "ai") === "ai" && item.imageEnabled)
    ? await fs.readFile(record.imagePath)
    : null;
  const reusableKeys = fields.filter((item) => !keysToRun.has(item.key)).map((item) => item.key);
  const context = getFieldResultContext(recordId, reusableKeys, sectionId);
  const missing = field.dependsOn.filter((key) => context[key] === undefined && record.sourceFields[key] === undefined);
  if (missing.length) throw new Error(`依赖字段未完成：${missing.join(", ")}`);
  const executedStates = await executeFieldGraph(fieldsToRun, async (item, currentContext) => {
    const run = await runField(recordId, section.name, record, item, currentContext, image);
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
