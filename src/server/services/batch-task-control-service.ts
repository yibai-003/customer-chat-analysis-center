import { z } from "zod";
import type { AnalysisJobOptions, BatchJobControlResult, Job } from "../../shared/types";
import { requestJobPause, getJob } from "../db/repositories";
import { analyzeJob } from "./batch-analysis-service";

const batchControlInput = z.object({
  action: z.enum(["pause", "resume"]),
  ids: z.array(z.string().min(1).max(200)).min(1).max(50),
  concurrency: z.number().int().min(1).max(6).optional(),
  batchSize: z.number().int().min(5).max(100).optional(),
  maxPaidTokens: z.number().int().min(0).max(100_000_000).optional(),
});

type BatchControlInput = z.infer<typeof batchControlInput>;
type RunOptions = Pick<AnalysisJobOptions, "concurrency" | "batchSize" | "maxPaidTokens">;
type StartJob = (jobId: string, sectionId: string, options: RunOptions) => Promise<unknown>;

export interface BatchControlDependencies {
  getJob: (jobId: string) => Job | undefined;
  pauseJob: (jobId: string) => Job | undefined;
  startJob: StartJob;
  reportStartError?: (error: unknown) => void;
}

const defaultDependencies: BatchControlDependencies = {
  getJob,
  pauseJob: requestJobPause,
  startJob: (jobId, sectionId, options) => analyzeJob(jobId, sectionId, options),
  reportStartError: (error) => console.error("批量继续解析失败", error),
};

export async function controlJobsInBatch(
  rawInput: BatchControlInput,
  overrides: Partial<BatchControlDependencies> = {},
): Promise<BatchJobControlResult[]> {
  const input = batchControlInput.parse(rawInput);
  const dependencies = { ...defaultDependencies, ...overrides };
  const ids = [...new Set(input.ids)];
  const results: BatchJobControlResult[] = [];
  const runOptions: RunOptions = {
    concurrency: input.concurrency,
    batchSize: input.batchSize,
    maxPaidTokens: input.maxPaidTokens,
  };

  for (const jobId of ids) {
    let job: Job | undefined;
    try {
      job = dependencies.getJob(jobId);
    } catch (error) {
      results.push({
        jobId,
        outcome: "failed",
        reason: error instanceof Error ? error.message : "读取任务状态失败",
      });
      continue;
    }
    if (!job) {
      results.push({ jobId, outcome: "failed", reason: "任务不存在或已删除" });
      continue;
    }

    if (input.action === "pause") {
      if (job.status !== "processing") {
        results.push({
          jobId,
          outcome: "skipped",
          status: job.status,
          reason: job.status === "paused" ? "任务已暂停" : "只有解析中的任务可以暂停",
        });
        continue;
      }
      try {
        const updated = dependencies.pauseJob(jobId);
        if (updated?.status === "paused") {
          results.push({ jobId, outcome: "success", status: "paused" });
        } else {
          results.push({
            jobId,
            outcome: "skipped",
            status: updated?.status,
            reason: "任务状态已变化，请刷新后重试",
          });
        }
      } catch (error) {
        results.push({
          jobId,
          outcome: "failed",
          status: job.status,
          reason: error instanceof Error ? error.message : "暂停任务失败",
        });
      }
      continue;
    }

    if (job.status !== "paused") {
      results.push({
        jobId,
        outcome: "skipped",
        status: job.status,
        reason: "只有已暂停的任务可以继续",
      });
      continue;
    }
    if (!job.sectionId) {
      results.push({
        jobId,
        outcome: "failed",
        status: job.status,
        reason: "任务未绑定解析板块，无法继续",
      });
      continue;
    }

    try {
      const completion = dependencies.startJob(jobId, job.sectionId, runOptions);
      void completion.catch((error) => dependencies.reportStartError?.(error));
      results.push({ jobId, outcome: "success", status: "processing" });
    } catch (error) {
      results.push({
        jobId,
        outcome: "failed",
        status: dependencies.getJob(jobId)?.status ?? job.status,
        reason: error instanceof Error ? error.message : "启动任务失败",
      });
    }
  }

  return results;
}
