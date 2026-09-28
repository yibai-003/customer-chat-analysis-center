import { describe, expect, it, vi } from "vitest";
import type { Job } from "../../shared/types";
import { controlJobsInBatch } from "./batch-task-control-service";

function job(id: string, status: Job["status"], sectionId = "reception"): Job {
  return {
    id,
    status,
    sectionId,
    sectionName: "接待流程质检",
    sectionConfigVersionId: "bound-version",
    sectionConfigVersionNumber: 4,
    originalFilename: `${id}.xlsx`,
    totalRecords: 3,
    completedRecords: 0,
    failedRecords: 0,
    totalFields: 0,
    completedFields: 0,
    failedFields: 0,
    skippedFields: 0,
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
  } as Job;
}

describe("batch task controls", () => {
  it("pauses only processing tasks and reports ineligible tasks without stopping the batch", async () => {
    const jobs = new Map([
      ["running", job("running", "processing")],
      ["paused", job("paused", "paused")],
      ["done", job("done", "completed")],
    ]);
    const pauseJob = vi.fn((id: string) => {
      const current = jobs.get(id)!;
      if (current.status === "processing") jobs.set(id, { ...current, status: "paused" });
      return jobs.get(id)!;
    });

    await expect(controlJobsInBatch(
      { action: "pause", ids: ["running", "paused", "done"] },
      { getJob: (id) => jobs.get(id), pauseJob, startJob: vi.fn() },
    )).resolves.toEqual([
      { jobId: "running", outcome: "success", status: "paused" },
      { jobId: "paused", outcome: "skipped", status: "paused", reason: "任务已暂停" },
      { jobId: "done", outcome: "skipped", status: "completed", reason: "只有解析中的任务可以暂停" },
    ]);
    expect(pauseJob).toHaveBeenCalledTimes(1);
  });

  it("resumes paused tasks with their bound section and isolates per-task start failures", async () => {
    const jobs = new Map([
      ["first", job("first", "paused", "reception")],
      ["second", job("second", "paused", "refund")],
      ["running", job("running", "processing")],
    ]);
    const startJob = vi.fn((id: string, _sectionId: string) => {
      if (id === "second") throw new Error("任务正在运行或当前状态不允许解析");
      return Promise.resolve({ total: 0, completed: 0, failed: 0, needsReview: 0 });
    });

    await expect(controlJobsInBatch(
      {
        action: "resume",
        ids: ["first", "second", "running"],
        concurrency: 3,
        batchSize: 25,
        maxPaidTokens: 6000,
      },
      { getJob: (id) => jobs.get(id), pauseJob: vi.fn(), startJob },
    )).resolves.toEqual([
      { jobId: "first", outcome: "success", status: "processing" },
      { jobId: "second", outcome: "failed", status: "paused", reason: "任务正在运行或当前状态不允许解析" },
      { jobId: "running", outcome: "skipped", status: "processing", reason: "只有已暂停的任务可以继续" },
    ]);
    expect(startJob).toHaveBeenNthCalledWith(1, "first", "reception", {
      concurrency: 3,
      batchSize: 25,
      maxPaidTokens: 6000,
    });
    expect(startJob).toHaveBeenNthCalledWith(2, "second", "refund", {
      concurrency: 3,
      batchSize: 25,
      maxPaidTokens: 6000,
    });
  });

  it("treats repeated pause and resume requests as skips instead of repeating work", async () => {
    let current = job("one", "processing");
    const pauseJob = vi.fn(() => {
      current = { ...current, status: "paused" };
      return current;
    });
    const startJob = vi.fn(() => {
      current = { ...current, status: "processing" };
      return Promise.resolve({ total: 0, completed: 0, failed: 0, needsReview: 0 });
    });
    const dependencies = {
      getJob: () => current,
      pauseJob,
      startJob,
    };

    await controlJobsInBatch({ action: "pause", ids: ["one"] }, dependencies);
    await expect(controlJobsInBatch({ action: "pause", ids: ["one"] }, dependencies))
      .resolves.toMatchObject([{ outcome: "skipped", reason: "任务已暂停" }]);
    await controlJobsInBatch({ action: "resume", ids: ["one"] }, dependencies);
    await expect(controlJobsInBatch({ action: "resume", ids: ["one"] }, dependencies))
      .resolves.toMatchObject([{ outcome: "skipped", reason: "只有已暂停的任务可以继续" }]);

    expect(pauseJob).toHaveBeenCalledTimes(1);
    expect(startJob).toHaveBeenCalledTimes(1);
  });

  it("rejects empty or oversized batches", async () => {
    const dependencies = { getJob: vi.fn(), pauseJob: vi.fn(), startJob: vi.fn() };
    await expect(controlJobsInBatch({ action: "pause", ids: [] }, dependencies)).rejects.toThrow();
    await expect(controlJobsInBatch(
      { action: "pause", ids: Array.from({ length: 51 }, (_, index) => `job-${index}`) },
      dependencies,
    )).rejects.toThrow();
    expect(dependencies.getJob).not.toHaveBeenCalled();
  });

  it("records an individual repository failure and continues with the remaining tasks", async () => {
    const jobs = new Map([
      ["first", job("first", "processing")],
      ["second", job("second", "processing")],
    ]);
    const pauseJob = vi.fn((id: string) => {
      if (id === "first") throw new Error("数据库暂时不可用");
      jobs.set(id, { ...jobs.get(id)!, status: "paused" });
      return jobs.get(id);
    });

    await expect(controlJobsInBatch(
      { action: "pause", ids: ["first", "second"] },
      { getJob: (id) => jobs.get(id), pauseJob },
    )).resolves.toEqual([
      { jobId: "first", outcome: "failed", status: "processing", reason: "数据库暂时不可用" },
      { jobId: "second", outcome: "success", status: "paused" },
    ]);
  });

  it("deduplicates task ids within one request", async () => {
    const current = job("one", "processing");
    const pauseJob = vi.fn(() => ({ ...current, status: "paused" as const }));

    await expect(controlJobsInBatch(
      { action: "pause", ids: ["one", "one"] },
      { getJob: () => current, pauseJob },
    )).resolves.toEqual([{ jobId: "one", outcome: "success", status: "paused" }]);
    expect(pauseJob).toHaveBeenCalledTimes(1);
  });
});
