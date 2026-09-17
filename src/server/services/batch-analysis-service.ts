import { runOwnership, assertRunOwnership } from "./run-ownership";
import { withAnalysisCancellation, analysisSignal } from "./analysis-cancellation";
import { z } from "zod";
import {
  acquireJobRun,
  assertJobSection,
  getAnalysisProgressBaseline,
  getJob,
  getJobRunToken,
  getRecord,
  listBatchRecordIds,
  releaseJobRun,
  resetFailedRecords,
  restoreFailedRecords,
  updateJobProgress,
  touchJobRun,
  updateRecord,
  settleCancelledRecord,
} from "../db/repositories";
import { analyzeRecordFields } from "./field-analysis-service";
import { config } from "../config";
import { db } from "../db/client";
import type { AnalysisJobOptions, BatchProgress, Job, RecordStatus } from "../../shared/types";
import { listFields } from "./field-config-service";
import { withPaidTokenBudget } from "../ai/model-budget";

interface AnalysisProgress extends BatchProgress {
  completedFields: number;
  failedFields: number;
  skippedFields: number;
}

interface RunInBatchesOptions<T> {
  batchSize: number;
  concurrency: number;
  loadBatch: (limit: number) => Promise<T[]>;
  runItem: (item: T) => Promise<void>;
  shouldStop: () => boolean;
  onBatchComplete?: () => Promise<void> | void;
}

interface AnalysisPreparationDependencies {
  getProgressBaseline: typeof getAnalysisProgressBaseline;
  listAnalysisFields: typeof listFields;
}

interface PreparedAnalysisJob {
  jobId: string;
  sectionId: string;
  runOptions: ReturnType<typeof resolveAnalysisRunOptions>;
  progress: AnalysisProgress;
  enabledFieldIds: Set<string>;
  totalFields: number;
}

export interface StartedAnalysisJob {
  completion: Promise<BatchProgress>;
}

const NORMAL_BATCH_STATUSES: RecordStatus[] = ["pending", "failed", "needs_review"];
export const MAX_TARGETED_RECORDS = 200;

export function prepareTargetedRecordIds(jobId: string, raw: unknown): {
  selected: number;
  executable: string[];
  skipped: number;
} {
  const parsed = z.array(z.string().min(1).max(200)).min(1).max(MAX_TARGETED_RECORDS).parse(raw);
  const unique = [...new Set(parsed)];
  if (unique.length !== parsed.length) throw new Error("记录 ID 不能重复");
  const placeholders = unique.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id, job_id, status FROM records WHERE id IN (${placeholders})`)
    .all(...unique) as Array<{ id: string; job_id: string; status: RecordStatus }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (unique.some((id) => byId.get(id)?.job_id !== jobId)) {
    throw new Error("记录不存在或不属于当前任务");
  }
  const executable = unique.filter((id) => NORMAL_BATCH_STATUSES.includes(byId.get(id)!.status));
  return { selected: unique.length, executable, skipped: unique.length - executable.length };
}
const defaultPreparationDependencies: AnalysisPreparationDependencies = {
  getProgressBaseline: getAnalysisProgressBaseline,
  listAnalysisFields: listFields,
};

export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  runner: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length || 1));
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await runner(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function shouldStopBatch(job: { status: string; cancelRequested?: boolean }) {
  return job.cancelRequested === true || job.status === "paused" || job.status === "cancelled";
}

export async function runInBatches<T>(options: RunInBatchesOptions<T>): Promise<void> {
  while (!options.shouldStop()) {
    const batch = await options.loadBatch(options.batchSize);
    if (!batch.length) return;
    await runWithConcurrency(batch, options.concurrency, async (item) => {
      if (options.shouldStop()) return;
      await options.runItem(item);
    });
    await options.onBatchComplete?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function validInteger(value: unknown, min: number, max: number) {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}

export function resolveAnalysisRunOptions(
  options: AnalysisJobOptions = {},
  defaults = {
    concurrency: config.analysisConcurrency,
    batchSize: config.analysisBatchSize,
  },
): Required<Pick<AnalysisJobOptions, "concurrency" | "batchSize" | "maxPaidTokens">> & Pick<AnalysisJobOptions, "recordIds"> {
  const defaultConcurrency = validInteger(defaults.concurrency, 1, 6) ? defaults.concurrency : 2;
  const defaultBatchSize = validInteger(defaults.batchSize, 5, 100) ? defaults.batchSize : 20;
  return {
    concurrency: validInteger(options.concurrency, 1, 6) ? options.concurrency! : defaultConcurrency,
    batchSize: validInteger(options.batchSize, 5, 100) ? options.batchSize! : defaultBatchSize,
    maxPaidTokens: validInteger(options.maxPaidTokens, 0, 100_000_000) ? options.maxPaidTokens! : 0,
    recordIds: options.recordIds,
  };
}

function latestFieldCounts(
  record: NonNullable<ReturnType<typeof getRecord>>,
  sectionId: string,
  enabledFieldIds: Set<string>,
) {
  const latestByField = new Map<string, (typeof record.fieldRuns)[number]>();
  for (const run of record.fieldRuns) {
    if (run.sectionId === sectionId && enabledFieldIds.has(run.fieldId) && !latestByField.has(run.fieldId)) {
      latestByField.set(run.fieldId, run);
    }
  }
  const runs = [...latestByField.values()];
  return {
    completed: runs.filter((run) => run.status === "completed").length,
    failed: runs.filter((run) => run.status === "failed").length,
    skipped: runs.filter((run) => run.status === "skipped").length,
  };
}

function removePreviousContribution(
  progress: AnalysisProgress,
  record: NonNullable<ReturnType<typeof getRecord>>,
  sectionId: string,
  enabledFieldIds: Set<string>,
) {
  if (record.status === "completed") progress.completed = Math.max(0, progress.completed - 1);
  if (record.status === "failed") progress.failed = Math.max(0, progress.failed - 1);
  if (record.status === "needs_review") progress.needsReview = Math.max(0, progress.needsReview - 1);
  const fields = latestFieldCounts(record, sectionId, enabledFieldIds);
  progress.completedFields = Math.max(0, progress.completedFields - fields.completed);
  progress.failedFields = Math.max(0, progress.failedFields - fields.failed);
  progress.skippedFields = Math.max(0, progress.skippedFields - fields.skipped);
}

function writeProgress(jobId: string, progress: AnalysisProgress, status: Job["status"], totalFields?: number) {
  updateJobProgress(jobId, {
    status,
    completedRecords: progress.completed,
    failedRecords: progress.failed,
    totalFields,
    completedFields: progress.completedFields,
    failedFields: progress.failedFields,
    skippedFields: progress.skippedFields,
  });
}

function prepareAcquiredAnalysisJob(
  jobId: string,
  sectionId: string,
  options: AnalysisJobOptions = {},
  dependencies: AnalysisPreparationDependencies = defaultPreparationDependencies,
): PreparedAnalysisJob {
  const runOptions = resolveAnalysisRunOptions(options);
  const enabledFields = dependencies.listAnalysisFields(sectionId).filter((field) => field.isEnabled);
  const progress: AnalysisProgress = dependencies.getProgressBaseline(jobId, sectionId);
  const totalFields = progress.total * enabledFields.length;
  writeProgress(jobId, progress, "processing", totalFields);
  return {
    jobId,
    sectionId,
    runOptions,
    progress,
    enabledFieldIds: new Set(enabledFields.map((field) => field.id)),
    totalFields,
  };
}

async function runPreparedAnalysisJob(prepared: PreparedAnalysisJob): Promise<BatchProgress> {
  const {
    jobId,
    sectionId,
    runOptions,
    progress,
    enabledFieldIds,
  } = prepared;
  const token = getJobRunToken(jobId);
  if (!token) throw new Error("Task run lock missing");
  return withAnalysisCancellation(jobId, token, () => runOwnership.run({ jobId, token }, async () => {
  const heartbeat = setInterval(() => touchJobRun(jobId, token), 10_000);
  try {
    const explicitRecordIds = runOptions.recordIds ? [...runOptions.recordIds] : undefined;
    let explicitIndex = 0;
    let afterRecordId: string | undefined;
    await runInBatches({
      batchSize: runOptions.batchSize,
      concurrency: runOptions.concurrency,
      shouldStop: () => shouldStopBatch(getJob(jobId) ?? { status: "cancelled" }),
      loadBatch: async (limit) => {
        if (explicitRecordIds) {
          const batch = explicitRecordIds.slice(explicitIndex, explicitIndex + limit);
          explicitIndex += batch.length;
          return batch;
        }
        const batch = listBatchRecordIds(jobId, limit, NORMAL_BATCH_STATUSES, afterRecordId);
        afterRecordId = batch.at(-1);
        return batch;
      },
      runItem: async (recordId) => {
        assertRunOwnership(jobId);
        const record = getRecord(recordId);
        if (!record) return;
        removePreviousContribution(progress, record, sectionId, enabledFieldIds);
        try {
          const result = await analyzeRecordFields(record.id, sectionId);
          if (result.failed > 0) progress.failed++;
          else if (result.needsReview > 0 || result.skipped > 0) progress.needsReview++;
          else progress.completed++;
          progress.completedFields += result.completed;
          progress.failedFields += result.failed;
          progress.skippedFields += result.skipped;
        } catch {
          if (analysisSignal()?.aborted) { settleCancelledRecord(record.id, jobId, token); return; }
          progress.failed++;
          if (getRecord(record.id)) updateRecord(record.id, { status: "failed", reviewStatus: "needs_review" });
        }
      },
      onBatchComplete: () => {
        const status = getJob(jobId)?.status ?? "processing";
        writeProgress(jobId, progress, status);
      },
    });
    const currentJob = getJob(jobId);
    const finalProgress = getAnalysisProgressBaseline(jobId, sectionId);
    const finalStatus = currentJob?.status === "cancelled"
      ? "cancelled"
      : currentJob?.status === "paused"
        ? "paused"
        : finalProgress.failed > 0 ? "failed" : finalProgress.pending > 0 || finalProgress.processing > 0 ? "paused" : "completed";
    writeProgress(jobId, finalProgress, finalStatus);
    return finalProgress;
  } finally {
    clearInterval(heartbeat);
    const currentJob = getJob(jobId);
    if (currentJob) releaseJobRun(jobId, currentJob.status === "processing" ? "failed" : currentJob.status, token);
  }
  }));
}

export function analyzeJob(
  jobId: string,
  sectionId: string,
  options: AnalysisJobOptions = {},
): Promise<BatchProgress> {
  assertJobSection(jobId, sectionId);
  const job = getJob(jobId)!;
  if (!acquireJobRun(jobId)) throw new Error("任务正在运行或当前状态不允许解析");
  try {
    const prepared = prepareAcquiredAnalysisJob(jobId, sectionId, options);
    return withPaidTokenBudget(
      () => runPreparedAnalysisJob(prepared),
      { maxPaidTokens: prepared.runOptions.maxPaidTokens },
    );
  } catch (error) {
    releaseJobRun(jobId, job.status);
    throw error;
  }
}

export async function retryFailedJob(
  jobId: string,
  dependencies: Partial<AnalysisPreparationDependencies> = {},
): Promise<StartedAnalysisJob | null> {
  const job = getJob(jobId);
  if (!job || !job.sectionId) throw new Error("任务未绑定解析板块");
  if (!acquireJobRun(jobId)) throw new Error("任务正在运行或当前状态不允许解析");
  let recordIds: string[] = [];
  try {
    recordIds = resetFailedRecords(jobId);
    if (!recordIds.length) {
      releaseJobRun(jobId, job.status);
      return null;
    }
    const prepared = prepareAcquiredAnalysisJob(
      jobId,
      job.sectionId,
      { recordIds },
      { ...defaultPreparationDependencies, ...dependencies },
    );
    return { completion: runPreparedAnalysisJob(prepared) };
  } catch (error) {
    restoreFailedRecords(jobId, recordIds);
    releaseJobRun(jobId, job.status);
    throw error;
  }
}
