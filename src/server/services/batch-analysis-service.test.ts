import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { loginAdmin, withAuth } from "../auth/test-admin";
import { db, initDb } from "../db/client";
import {
  acquireJobRun,
  addRecords,
  countActiveJobRuns,
  createJob,
  getJob,
  listRecords,
  releaseJobRun,
  requestJobCancel,
  requestJobPause,
  resetFailedRecords,
  upsertSection,
  updateRecord,
} from "../db/repositories";
import { analyzeRecordFields } from "./field-analysis-service";
import { listFields, upsertField } from "./field-config-service";
import { createFieldRun } from "./field-run-service";
import { createDraftVersion, publishSectionVersion } from "./section-config-version-service";
import { paidTokensRemaining } from "../ai/model-budget";
import {
  analyzeJob,
  prepareTargetedRecordIds,
  retryFailedJob,
  resolveAnalysisRunOptions,
  runInBatches,
  runWithConcurrency,
  shouldStopBatch,
} from "./batch-analysis-service";

vi.mock("./field-analysis-service", () => ({
  analyzeRecordFields: vi.fn(),
}));

beforeAll(() => initDb());

beforeEach(() => {
  vi.mocked(analyzeRecordFields).mockReset();
});

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("等待测试条件超时");
}

describe("batch analysis concurrency", () => {
  it("limits active runners and preserves item order", async () => {
    let active = 0;
    let maxActive = 0;
    const result = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return value * 2;
    });

    expect(maxActive).toBe(2);
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });

  it("stops starting work after pause or cancellation", () => {
    expect(shouldStopBatch({ status: "paused", cancelRequested: false })).toBe(true);
    expect(shouldStopBatch({ status: "processing", cancelRequested: true })).toBe(true);
    expect(shouldStopBatch({ status: "processing", cancelRequested: false })).toBe(false);
  });
});

describe("batch analysis scheduling", () => {
  it("does not declare the whole job complete after retrying a subset", async () => {
    const job = createJob("partial.xlsx", "partial.xlsx", { id: "refund", name: "refund" });
    addRecords(job.id, [1,2].map(rowNumber => ({ sheetName: "Sheet1", rowNumber, anchor: {}, sourceFields: {}, imagePath: "test.png" })));
    const records = listRecords(job.id);
    updateRecord(records[0].id, { status: "failed" });
    vi.mocked(analyzeRecordFields).mockImplementation(async id => {
      for (const field of listFields("refund").filter(f => f.isEnabled)) createFieldRun({ recordId: id, fieldId: field.id, status: "completed" });
      updateRecord(id, { status: "completed" });
      return { total: 5, completed: 5, failed: 0, needsReview: 0, skipped: 0 };
    });
    const retry = await retryFailedJob(job.id);
    await retry!.completion;
    expect(getJob(job.id)).toMatchObject({ status: "paused", completedRecords: 1, pendingRecords: 1, failedRecords: 0, completedFields: 5 });
  });
  it("loads records one batch at a time until the candidate query is empty", async () => {
    const loaded: number[] = [];
    const processed: number[] = [];

    await runInBatches({
      batchSize: 2,
      concurrency: 1,
      loadBatch: async () => {
        loaded.push(1);
        return loaded.length === 1 ? [1, 2] : loaded.length === 2 ? [3] : [];
      },
      runItem: async (item) => {
        processed.push(item);
      },
      shouldStop: () => false,
    });

    expect(loaded).toHaveLength(3);
    expect(processed).toEqual([1, 2, 3]);
  });

  it("validates targeted record selections and splits executable from skipped records", () => {
    const job = createJob("targeted.xlsx", "targeted.xlsx", { id: "refund", name: "refund" });
    addRecords(job.id, [1, 2, 3, 4].map((rowNumber) => ({
      sheetName: "Sheet1", rowNumber, anchor: {}, sourceFields: {}, imagePath: "test.png",
    })));
    const records = listRecords(job.id);
    updateRecord(records[0].id, { status: "completed" });
    updateRecord(records[1].id, { status: "failed" });
    const otherJob = createJob("other.xlsx", "other.xlsx", { id: "refund", name: "refund" });
    addRecords(otherJob.id, [{ sheetName: "Sheet1", rowNumber: 1, anchor: {}, sourceFields: {}, imagePath: "other.png" }]);
    const otherRecord = listRecords(otherJob.id)[0];

    expect(prepareTargetedRecordIds(job.id, [records[1].id, records[0].id, records[2].id]))
      .toEqual({ selected: 3, executable: [records[1].id, records[2].id], skipped: 1 });
    expect(() => prepareTargetedRecordIds(job.id, [])).toThrow();
    expect(() => prepareTargetedRecordIds(job.id, [records[1].id, records[1].id])).toThrow("不能重复");
    expect(() => prepareTargetedRecordIds(job.id, [otherRecord.id])).toThrow("不属于当前任务");
    expect(() => prepareTargetedRecordIds(job.id, ["missing-record"])).toThrow("不属于当前任务");
    expect(() => prepareTargetedRecordIds(job.id, Array.from({ length: 201 }, (_, index) => `missing-${index}`)))
      .toThrow();
  });

  it("does not load another batch after a pause is requested", async () => {
    let stopped = false;
    let loadCount = 0;

    await runInBatches({
      batchSize: 2,
      concurrency: 1,
      loadBatch: async () => {
        loadCount++;
        return [1, 2];
      },
      runItem: async () => {
        stopped = true;
      },
      shouldStop: () => stopped,
    });

    expect(loadCount).toBe(1);
  });

  it("does not start another item after a cancellation is requested", async () => {
    let stopped = false;
    const processed: number[] = [];

    await runInBatches({
      batchSize: 3,
      concurrency: 1,
      loadBatch: async () => [1, 2, 3],
      runItem: async (item) => {
        processed.push(item);
        stopped = true;
      },
      shouldStop: () => stopped,
    });

    expect(processed).toEqual([1]);
  });

  it("reports progress once per non-empty batch and yields before the next load", async () => {
    const events: string[] = [];
    let loadCount = 0;

    await runInBatches({
      batchSize: 2,
      concurrency: 1,
      loadBatch: async () => {
        loadCount++;
        events.push(`load-${loadCount}`);
        return loadCount === 1 ? [1, 2] : [];
      },
      runItem: async () => undefined,
      shouldStop: () => false,
      onBatchComplete: () => {
        events.push("progress");
        setImmediate(() => events.push("external-immediate"));
      },
    });

    expect(events).toEqual([
      "load-1",
      "progress",
      "external-immediate",
      "load-2",
    ]);
  });

  it("uses valid runtime values and falls back for out-of-range values", () => {
    expect(resolveAnalysisRunOptions()).toEqual({
      concurrency: 2,
      batchSize: 20,
      maxPaidTokens: 0,
      recordIds: undefined,
    });

    expect(resolveAnalysisRunOptions(
      { concurrency: 6, batchSize: 100 },
      { concurrency: 2, batchSize: 20 },
    )).toEqual({ concurrency: 6, batchSize: 100, maxPaidTokens: 0, recordIds: undefined });

    expect(resolveAnalysisRunOptions(
      { maxPaidTokens: 100_000_000 },
      { concurrency: 2, batchSize: 20 },
    )).toEqual({ concurrency: 2, batchSize: 20, maxPaidTokens: 100_000_000, recordIds: undefined });

    expect(resolveAnalysisRunOptions(
      { maxPaidTokens: 100_001 },
      { concurrency: 2, batchSize: 20 },
    )).toEqual({ concurrency: 2, batchSize: 20, maxPaidTokens: 100_001, recordIds: undefined });

    expect(resolveAnalysisRunOptions(
      { concurrency: 0, batchSize: 101 },
      { concurrency: 2, batchSize: 20 },
    )).toEqual({ concurrency: 2, batchSize: 20, maxPaidTokens: 0, recordIds: undefined });

    expect(resolveAnalysisRunOptions(
      { concurrency: 1.5, batchSize: Number.NaN },
      { concurrency: 3, batchSize: 30 },
    )).toEqual({ concurrency: 3, batchSize: 30, maxPaidTokens: 0, recordIds: undefined });

    expect(resolveAnalysisRunOptions(
      { maxPaidTokens: -1 },
      { concurrency: 3, batchSize: 30 },
    )).toEqual({ concurrency: 3, batchSize: 30, maxPaidTokens: 0, recordIds: undefined });

    expect(resolveAnalysisRunOptions(
      { maxPaidTokens: 1.5 },
      { concurrency: 3, batchSize: 30 },
    )).toEqual({ concurrency: 3, batchSize: 30, maxPaidTokens: 0, recordIds: undefined });

    expect(resolveAnalysisRunOptions(
      { maxPaidTokens: 100_000_001 },
      { concurrency: 3, batchSize: 30 },
    )).toEqual({ concurrency: 3, batchSize: 30, maxPaidTokens: 0, recordIds: undefined });
  });

  it("runs the prepared batch inside the requested paid-token budget", async () => {
    const job = createJob("paid-budget.xlsx", "paid-budget.xlsx", {
      id: "refund",
      name: "付费预算",
    });
    addRecords(job.id, [{
      sheetName: "Sheet1",
      rowNumber: 1,
      anchor: {},
      sourceFields: {},
      imagePath: "paid-budget.png",
    }]);
    vi.mocked(analyzeRecordFields).mockImplementation(async () => {
      expect(paidTokensRemaining()).toBe(1234);
      return { total: 0, completed: 0, failed: 0, needsReview: 0, skipped: 0 };
    });

    await analyzeJob(job.id, "refund", { concurrency: 1, batchSize: 5, maxPaidTokens: 1234 });
  });

  it("rebuilds progress from records and latest field runs before batch analysis", async () => {
    const job = createJob("continued-progress.xlsx", "continued-progress.xlsx", {
      id: "refund",
      name: "退货分析",
    });
    addRecords(job.id, [
      { sheetName: "Sheet1", rowNumber: 1, anchor: {}, sourceFields: {}, imagePath: "completed.png" },
      { sheetName: "Sheet1", rowNumber: 2, anchor: {}, sourceFields: {}, imagePath: "pending.png" },
    ]);
    const records = listRecords(job.id);
    updateRecord(records[0].id, { status: "completed" });
    const fields = listFields("refund").filter((field) => field.isEnabled);
    createFieldRun({ recordId: records[0].id, fieldId: fields[0].id, status: "failed" });
    createFieldRun({ recordId: records[0].id, fieldId: fields[0].id, status: "completed" });
    for (const field of fields.slice(1)) {
      createFieldRun({ recordId: records[0].id, fieldId: field.id, status: "completed" });
    }
    expect(getJob(job.id)).toMatchObject({
      completedRecords: 1,
      completedFields: 5,
      failedFields: 0,
    });
    vi.mocked(analyzeRecordFields).mockImplementation(async (recordId) => {
      for (const field of fields.slice(0, 3)) createFieldRun({ recordId, fieldId: field.id, status: "completed" });
      updateRecord(recordId, { status: "completed", reviewStatus: "pending" });
      return {
        total: 3,
        completed: 3,
        failed: 0,
        needsReview: 0,
        skipped: 0,
      };
    });

    await analyzeJob(job.id, "refund", { concurrency: 1, batchSize: 5 });

    expect(vi.mocked(analyzeRecordFields).mock.calls).toEqual([
      [records[1].id, "refund"],
    ]);
    expect(getJob(job.id)).toMatchObject({
      status: "completed",
      completedRecords: 2,
      failedRecords: 0,
      totalFields: 10,
      completedFields: 8,
      failedFields: 0,
      skippedFields: 0,
    });
  });

  it("uses the newest field run when timestamps are equal during reanalysis", async () => {
    const job = createJob("latest-field-run.xlsx", "latest-field-run.xlsx", {
      id: "refund",
      name: "退货分析",
    });
    addRecords(job.id, [{
      sheetName: "Sheet1",
      rowNumber: 1,
      anchor: {},
      sourceFields: {},
      imagePath: "latest-field-run.png",
    }]);
    const record = listRecords(job.id)[0];
    const fields = listFields("refund").filter((field) => field.isEnabled);
    updateRecord(record.id, { status: "needs_review", reviewStatus: "needs_review" });
    createFieldRun({ recordId: record.id, fieldId: fields[0].id, status: "failed" });
    createFieldRun({ recordId: record.id, fieldId: fields[0].id, status: "completed" });
    for (const field of fields.slice(1)) {
      createFieldRun({ recordId: record.id, fieldId: field.id, status: "completed" });
    }
    db.prepare("UPDATE analysis_field_runs SET created_at = ? WHERE record_id = ?")
      .run("2026-09-10T00:00:00.000Z", record.id);
    vi.mocked(analyzeRecordFields).mockImplementation(async (recordId) => {
      for (const field of fields.slice(0, 3)) createFieldRun({ recordId, fieldId: field.id, status: "completed" });
      updateRecord(recordId, { status: "completed", reviewStatus: "pending" });
      return {
        total: 3,
        completed: 3,
        failed: 0,
        needsReview: 0,
        skipped: 0,
      };
    });

    await analyzeJob(job.id, "refund", { concurrency: 1, batchSize: 5 });

    expect(getJob(job.id)).toMatchObject({
      status: "completed",
      completedRecords: 1,
      failedRecords: 0,
      completedFields: 5,
      failedFields: 0,
    });
  });

  it("excludes disabled fields from the rebuilt progress baseline", async () => {
    const sectionId = `disabled-baseline-${Date.now()}`;
    upsertSection({
      id: sectionId,
      name: "停用字段基线",
      prompt: "测试",
      outputSchema: [],
    });
    const enabledField = upsertField({
      sectionId,
      key: "enabled",
      label: "启用字段",
      type: "string",
      isEnabled: true,
    });
    const disabledField = upsertField({
      sectionId,
      key: "disabled",
      label: "停用字段",
      type: "string",
      isEnabled: false,
    });
    publishSectionVersion(createDraftVersion(sectionId).id);
    const job = createJob("disabled-baseline.xlsx", "disabled-baseline.xlsx", {
      id: sectionId,
      name: "停用字段基线",
    });
    addRecords(job.id, [{
      sheetName: "Sheet1",
      rowNumber: 1,
      anchor: {},
      sourceFields: {},
      imagePath: "disabled-baseline.png",
    }]);
    const record = listRecords(job.id)[0];
    updateRecord(record.id, { status: "completed" });
    createFieldRun({ recordId: record.id, fieldId: enabledField.id, status: "completed" });
    createFieldRun({ recordId: record.id, fieldId: disabledField.id, status: "completed" });

    await analyzeJob(job.id, sectionId, { concurrency: 1, batchSize: 5 });

    expect(getJob(job.id)).toMatchObject({
      status: "completed",
      completedRecords: 1,
      totalFields: 1,
      completedFields: 1,
      failedFields: 0,
      skippedFields: 0,
    });
  });

  it("keeps progress based on the bound field snapshot after live fields are deleted", async () => {
    const sectionId = `snapshot-progress-${Date.now()}`;
    upsertSection({
      id: sectionId,
      name: "版本进度基线",
      prompt: "测试",
      outputSchema: [],
    });
    const first = upsertField({
      sectionId,
      key: "first",
      label: "字段一",
      type: "string",
      isEnabled: true,
    });
    const second = upsertField({
      sectionId,
      key: "second",
      label: "字段二",
      type: "string",
      isEnabled: true,
    });
    publishSectionVersion(createDraftVersion(sectionId).id);
    const job = createJob("snapshot-progress.xlsx", "snapshot-progress.xlsx", {
      id: sectionId,
      name: "版本进度基线",
    });
    addRecords(job.id, [{
      sheetName: "Sheet1",
      rowNumber: 1,
      anchor: {},
      sourceFields: {},
      imagePath: "snapshot-progress.png",
    }]);
    const record = listRecords(job.id)[0];
    updateRecord(record.id, { status: "completed" });
    createFieldRun({
      recordId: record.id,
      fieldId: first.id,
      fieldSnapshot: first,
      status: "completed",
    });
    createFieldRun({
      recordId: record.id,
      fieldId: second.id,
      fieldSnapshot: second,
      status: "completed",
    });
    db.prepare("DELETE FROM analysis_fields WHERE section_id = ?").run(sectionId);

    await analyzeJob(job.id, sectionId, { concurrency: 1, batchSize: 5 });

    expect(getJob(job.id)).toMatchObject({
      status: "completed",
      completedRecords: 1,
      totalFields: 2,
      completedFields: 2,
      failedFields: 0,
      skippedFields: 0,
    });
    expect(analyzeRecordFields).not.toHaveBeenCalled();
  });

  it.each([
    ["paused", requestJobPause],
    ["cancelled", requestJobCancel],
  ] as const)("finishes in-flight concurrent items, stops new work, and releases the lock when %s", async (
    expectedStatus,
    requestStop,
  ) => {
    const job = createJob(`concurrent-${expectedStatus}.xlsx`, `concurrent-${expectedStatus}.xlsx`, {
      id: "refund",
      name: "退货分析",
    });
    addRecords(job.id, Array.from({ length: 3 }, (_, index) => ({
      sheetName: "Sheet1",
      rowNumber: index + 1,
      anchor: {},
      sourceFields: {},
      imagePath: `concurrent-${expectedStatus}-${index + 1}.png`,
    })));
    const started: string[] = [];
    const releases: Array<() => void> = [];
    vi.mocked(analyzeRecordFields).mockImplementation((recordId) => new Promise((resolve) => {
      started.push(recordId);
      releases.push(() => {
        for (const field of listFields("refund").filter(f => f.isEnabled).slice(0, 3)) createFieldRun({ recordId, fieldId: field.id, status: "completed" });
        updateRecord(recordId, { status: "completed", reviewStatus: "pending" });
        resolve({
          total: 3,
          completed: 3,
          failed: 0,
          needsReview: 0,
          skipped: 0,
        });
      });
    }));
    const activeRunsBefore = countActiveJobRuns();

    const run = analyzeJob(job.id, "refund", { concurrency: 2, batchSize: 5 });
    await waitFor(() => started.length === 2);
    expect(countActiveJobRuns()).toBe(activeRunsBefore + 1);

    requestStop(job.id);
    for (const release of releases) release();
    await run;

    expect(started).toHaveLength(2);
    expect(getJob(job.id)).toMatchObject({
      status: expectedStatus,
      completedRecords: 2,
      failedRecords: 0,
      completedFields: 6,
      failedFields: 0,
      skippedFields: 0,
    });
    expect(countActiveJobRuns()).toBe(activeRunsBefore);
    expect((db.prepare("SELECT run_token FROM jobs WHERE id = ?").get(job.id) as { run_token: string | null }).run_token)
      .toBeNull();
  });

  it("removes a reset failed record from the failed count when retry succeeds", async () => {
    const job = createJob("retry-progress.xlsx", "retry-progress.xlsx", {
      id: "refund",
      name: "退货分析",
    });
    addRecords(job.id, [{
      sheetName: "Sheet1",
      rowNumber: 1,
      anchor: {},
      sourceFields: {},
      imagePath: "retry-progress.png",
    }]);
    const record = listRecords(job.id)[0];
    updateRecord(record.id, { status: "failed", reviewStatus: "needs_review" });
    const recordIds = resetFailedRecords(job.id);
    vi.mocked(analyzeRecordFields).mockImplementation(async (recordId) => {
      updateRecord(recordId, { status: "completed", reviewStatus: "pending" });
      return {
        total: 3,
        completed: 3,
        failed: 0,
        needsReview: 0,
        skipped: 0,
      };
    });

    await analyzeJob(job.id, "refund", {
      concurrency: 1,
      batchSize: 5,
      recordIds,
    });

    expect(getJob(job.id)).toMatchObject({
      status: "completed",
      completedRecords: 1,
      failedRecords: 0,
    });
  });
});

describe("batch analysis API", () => {
  it("forwards per-run concurrency, batch size, and paid-token budget to analyzeJob", async () => {
    const calls: unknown[][] = [];
    const analyzeJobRunner = vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return { total: 0, completed: 0, failed: 0, needsReview: 0 };
    });
    const job = createJob("runtime-options.xlsx", "runtime-options.xlsx", {
      id: "refund",
      name: "退货分析",
    });
    const server: Server = createApp({ analyzeJobRunner } as never).listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;

    try {
      const cookie = await loginAdmin(`http://127.0.0.1:${address.port}`);
      const response = await fetch(`http://127.0.0.1:${address.port}/api/jobs/${job.id}/analyze`, withAuth(cookie, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sectionId: "refund", concurrency: 4, batchSize: 40, maxPaidTokens: 5000 }),
      }));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(response.status).toBe(200);
      expect(calls).toEqual([[
        job.id,
        "refund",
        { concurrency: 4, batchSize: 40, maxPaidTokens: 5000 },
      ]]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("keeps retry-failed compatible by delegating lock and reset as one startup operation", async () => {
    const retryFailedJobStarter = vi.fn(async () => {
      return {
        completion: Promise.resolve({ total: 1, completed: 0, failed: 1, needsReview: 0 }),
      };
    });
    const job = createJob("retry-options.xlsx", "retry-options.xlsx", {
      id: "refund",
      name: "退货分析",
    });
    addRecords(job.id, [{
      sheetName: "Sheet1",
      rowNumber: 1,
      anchor: {},
      sourceFields: {},
      imagePath: "retry-options.png",
    }]);
    const record = listRecords(job.id)[0];
    updateRecord(record.id, { status: "failed", reviewStatus: "needs_review" });
    const server: Server = createApp({ retryFailedJobStarter } as never).listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;

    try {
      const cookie = await loginAdmin(`http://127.0.0.1:${address.port}`);
      const response = await fetch(`http://127.0.0.1:${address.port}/api/jobs/${job.id}/retry-failed`, withAuth(cookie, {
        method: "POST",
      }));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(response.status).toBe(200);
      expect(retryFailedJobStarter).toHaveBeenCalledWith(job.id);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("returns a lock conflict without resetting failed records", async () => {
    const job = createJob("retry-lock-conflict.xlsx", "retry-lock-conflict.xlsx", {
      id: "refund",
      name: "退货分析",
    });
    addRecords(job.id, [{
      sheetName: "Sheet1",
      rowNumber: 1,
      anchor: {},
      sourceFields: {},
      imagePath: "retry-lock-conflict.png",
    }]);
    const record = listRecords(job.id)[0];
    updateRecord(record.id, { status: "failed", reviewStatus: "needs_review" });
    expect(acquireJobRun(job.id)).toBe(true);
    const server: Server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const cookie = await loginAdmin(`http://127.0.0.1:${address.port}`);
      const response = await fetch(`http://127.0.0.1:${address.port}/api/jobs/${job.id}/retry-failed`, withAuth(cookie, {
        method: "POST",
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        success: false,
        error: expect.stringContaining("正在运行"),
      });
      expect(listRecords(job.id)[0]).toMatchObject({
        status: "failed",
        reviewStatus: "needs_review",
      });
    } finally {
      consoleError.mockRestore();
      releaseJobRun(job.id, "failed");
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("rolls back retry reset and returns an error when preparation fails", async () => {
    const job = createJob("retry-prepare-failure.xlsx", "retry-prepare-failure.xlsx", {
      id: "refund",
      name: "退货分析",
    });
    addRecords(job.id, [{
      sheetName: "Sheet1",
      rowNumber: 1,
      anchor: {},
      sourceFields: {},
      imagePath: "retry-prepare-failure.png",
    }]);
    const record = listRecords(job.id)[0];
    updateRecord(record.id, { status: "failed", reviewStatus: "needs_review" });
    db.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(job.id);
    vi.mocked(analyzeRecordFields).mockResolvedValue({
      total: 3,
      completed: 0,
      failed: 3,
      needsReview: 0,
      skipped: 0,
    });
    const retryWithPreparationFailure = retryFailedJob as unknown as (
      jobId: string,
      dependencies: { getProgressBaseline: () => never },
    ) => Promise<{ completion: Promise<unknown> } | null>;
    const server: Server = createApp({
      retryFailedJobStarter: (jobId: string) => retryWithPreparationFailure(jobId, {
        getProgressBaseline: () => {
          throw new Error("准备阶段失败");
        },
      }),
    } as never).listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;

    try {
      const cookie = await loginAdmin(`http://127.0.0.1:${address.port}`);
      const response = await fetch(`http://127.0.0.1:${address.port}/api/jobs/${job.id}/retry-failed`, withAuth(cookie, {
        method: "POST",
      }));

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        success: false,
        error: "准备阶段失败",
      });
      expect(listRecords(job.id)[0]).toMatchObject({
        status: "failed",
        reviewStatus: "needs_review",
      });
      expect(getJob(job.id)?.status).toBe("failed");
      expect((db.prepare("SELECT run_token FROM jobs WHERE id = ?").get(job.id) as { run_token: string | null }).run_token)
        .toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("returns after retry preparation without waiting for batch completion", async () => {
    const job = createJob("retry-start-only.xlsx", "retry-start-only.xlsx", {
      id: "refund",
      name: "退货分析",
    });
    addRecords(job.id, [{
      sheetName: "Sheet1",
      rowNumber: 1,
      anchor: {},
      sourceFields: {},
      imagePath: "retry-start-only.png",
    }]);
    const record = listRecords(job.id)[0];
    updateRecord(record.id, { status: "failed", reviewStatus: "needs_review" });
    let release: (() => void) | undefined;
    vi.mocked(analyzeRecordFields).mockImplementation((recordId) => new Promise((resolve) => {
      release = () => {
        updateRecord(recordId, { status: "completed", reviewStatus: "pending" });
        resolve({
          total: 3,
          completed: 3,
          failed: 0,
          needsReview: 0,
          skipped: 0,
        });
      };
    }));
    const activeRunsBefore = countActiveJobRuns();
    const server: Server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;

    try {
      const cookie = await loginAdmin(`http://127.0.0.1:${address.port}`);
      const response = await Promise.race([
        fetch(`http://127.0.0.1:${address.port}/api/jobs/${job.id}/retry-failed`, withAuth(cookie, {
          method: "POST",
        })),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("接口等待了整个批次")), 10_000)),
      ]);

      expect(response.status).toBe(200);
      await waitFor(() => release !== undefined);
      expect(countActiveJobRuns()).toBe(activeRunsBefore + 1);
      release!();
      await waitFor(() => countActiveJobRuns() === activeRunsBefore);
      expect(getJob(job.id)).toMatchObject({
        status: "completed",
        completedRecords: 1,
      });
    } finally {
      if (release && countActiveJobRuns() > activeRunsBefore) release();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
