import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelConfig, ModelRouteResult } from "../../shared/types";
import { currentModelBudget } from "../ai/model-budget";
import { db, initDb } from "../db/client";
import { addRecords, createJob, getJob, getJobRunToken, getRecord, listRecords, requestJobCancel, requestJobPause, upsertSection } from "../db/repositories";
import { upsertField } from "./field-config-service";
import { createModelConfig } from "./model-config-service";
import { analyzeJob } from "./batch-analysis-service";
import { analyzeField } from "./field-analysis-service";
import { cancelAnalysis } from "./analysis-cancellation";
import { withSingleAnalysisRun } from "./single-analysis-run";
import { updateRecord } from "../db/repositories";

vi.mock("./model-pool-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-pool-service")>();
  return { ...actual, callModelPool: vi.fn() };
});
vi.mock("./field-run-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./field-run-service")>();
  return { ...actual, createFieldRun: vi.fn(actual.createFieldRun) };
});

import { callModelPool } from "./model-pool-service";
import { createFieldRun } from "./field-run-service";

beforeAll(() => initDb());
beforeEach(() => {
  vi.mocked(callModelPool).mockReset();
  vi.mocked(callModelPool).mockImplementation(async () => routedSuccess());
  vi.mocked(createFieldRun).mockClear();
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
function fixture() {
  const sectionId = randomUUID(); upsertSection({ id: sectionId, name: "cancel", prompt: "", outputSchema: [] });
  const fields = ["first", "second"].map((key, index) => upsertField({ sectionId, key, label: key, type: "string", imageEnabled: false, sortOrder: index }));
  const job = createJob("cancel.xlsx", "unused", { id: sectionId, name: "cancel" });
  addRecords(job.id, [1, 2].map(rowNumber => ({ rowNumber, sheetName: "s", anchor: {}, sourceFields: {}, imagePath: "unused" })));
  return { sectionId, job, fields, records: listRecords(job.id) };
}
const model: ModelConfig = {
  id: "cancel-model",
  name: "cancel model",
  baseUrl: "https://cancel.test/v1",
  maskedApiKey: "********",
  model: "local",
  supportsVision: false,
  temperature: 0,
  maxTokens: 200,
  isDefault: false,
  purpose: "text",
  isPurposeDefault: true,
  isEnabled: true,
  poolEnabled: true,
  billingMode: "free",
  qualityTier: "A",
  priority: 100,
  thinkingMode: false,
  memberType: "general",
  quotaTotalTokens: 1000,
  quotaUsedTokens: 0,
  quotaSafetyRatio: 0.95,
  consecutiveFailures: 0,
  capabilityEligible: true,
  quotaBlocked: false,
};
function routedSuccess(): ModelRouteResult {
  return {
    content: '{"first":"ok","second":"ok"}',
    raw: "{}",
    usage: {},
    model,
    attempts: [{
      modelConfigId: model.id,
      model: model.model,
      status: "success",
      durationMs: 1,
    }],
  };
}
function activeSignal() {
  const signal = currentModelBudget()?.signal;
  if (!signal) throw new Error("model budget signal missing");
  return signal;
}

describe("actual analysis cancellation", () => {
  it("settles single-record infrastructure errors instead of leaving a processing row", async () => {
    const f = fixture();
    await expect(withSingleAnalysisRun(f.records[0].id, f.sectionId, async () => {
      updateRecord(f.records[0].id, { status: "processing" }); throw new Error("queue timeout");
    })).rejects.toThrow("queue timeout");
    expect(getRecord(f.records[0].id)?.status).toBe("failed"); expect(getJobRunToken(f.job.id)).toBeUndefined();
  });
  it("aborts a stalled model route, leaves no processing rows, and never starts later fields or records", async () => {
    const requested = deferred<void>(); const disconnected = deferred<void>();
    vi.mocked(callModelPool).mockImplementationOnce(async () => {
      const signal = activeSignal();
      requested.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
        disconnected.resolve();
        reject(signal.reason);
      }, { once: true }));
    });
    const f = fixture();
    const run = analyzeJob(f.job.id, f.sectionId, { concurrency: 1, batchSize: 5 });
    await requested.promise; requestJobCancel(f.job.id); await run; await disconnected.promise;
    expect(callModelPool).toHaveBeenCalledTimes(1); expect(getJob(f.job.id)?.status).toBe("cancelled");
    expect(getJobRunToken(f.job.id)).toBeUndefined();
    for (const record of f.records) expect(getRecord(record.id)).toMatchObject({ status: "pending", fieldRuns: [] });
  });
  it("disconnects a real stalled transport through an eligible pool member", async () => {
    const requested = deferred<void>(); const disconnected = deferred<void>(); let count = 0;
    const server = createServer((_req, res) => {
      count++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"choices":');
      res.once("close", () => disconnected.resolve());
      requested.resolve();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
      const member = createModelConfig({
        name: "cancel transport", baseUrl, apiKey: "test-secret", model: "local",
        purpose: "text", supportsVision: false,
      });
      db.prepare(`UPDATE model_configs SET pool_enabled=1, billing_mode='free',
        quota_total_tokens=1000, quota_used_tokens=0, capability_json=?,
        capability_checked_at=? WHERE id=?`).run(
        JSON.stringify({ text: true, json: true, vision: false }),
        new Date().toISOString(),
        member.id,
      );
      const { callModelPool: route } = await vi.importActual<typeof import("./model-pool-service")>("./model-pool-service");
      vi.mocked(callModelPool).mockImplementation(route);
      const f = fixture();
      const run = analyzeJob(f.job.id, f.sectionId, { concurrency: 1, batchSize: 5 });
      await requested.promise;
      requestJobCancel(f.job.id);
      await run;
      await disconnected.promise;
      expect(count).toBe(1);
      expect(getJob(f.job.id)?.status).toBe("cancelled");
      expect(getJobRunToken(f.job.id)).toBeUndefined();
      for (const record of f.records) expect(getRecord(record.id)).toMatchObject({ status: "pending", fieldRuns: [] });
    } finally {
      await close(server);
    }
  });
  it("rejects a late response that ignores abort, retains committed fields, and can start a fresh run", async () => {
    const f = fixture(); const requested = deferred<AbortSignal>(); const late = deferred<ModelRouteResult>();
    vi.mocked(callModelPool)
      .mockResolvedValueOnce(routedSuccess())
      .mockImplementationOnce(async () => {
        requested.resolve(activeSignal());
        return late.promise;
      });
    const run = analyzeJob(f.job.id, f.sectionId, { concurrency: 1 });
    const signal = await requested.promise;
    requestJobCancel(f.job.id);
    expect(signal.aborted).toBe(true);
    late.resolve(routedSuccess()); await run;
    expect(callModelPool).toHaveBeenCalledTimes(2);
    expect(getRecord(f.records[0].id)?.fieldRuns).toHaveLength(1);
    expect(getRecord(f.records[0].id)?.fieldRuns[0].fieldKey).toBe("first");
    expect(getRecord(f.records[0].id)?.fieldRuns.some((fieldRun) => fieldRun.fieldKey === "second" && fieldRun.status === "completed")).toBe(false);
    expect(createFieldRun).toHaveBeenCalledTimes(1);
    expect(getRecord(f.records[0].id)?.status).toBe("pending");
    vi.mocked(callModelPool).mockImplementation(async () => routedSuccess());
    await analyzeJob(f.job.id, f.sectionId, { concurrency: 1 });
    expect(getJob(f.job.id)?.status).toBe("completed");
  });
  it("pause completes the in-flight record but does not begin the next record", async () => {
    const f = fixture(); const requested = deferred<void>(); const response = deferred<ModelRouteResult>();
    vi.mocked(callModelPool).mockImplementationOnce(async () => {
      requested.resolve();
      return response.promise;
    });
    const run = analyzeJob(f.job.id, f.sectionId, { concurrency: 1 });
    await requested.promise; requestJobPause(f.job.id); response.resolve(routedSuccess()); await run;
    expect(callModelPool).toHaveBeenCalledTimes(2); expect(getJob(f.job.id)?.status).toBe("paused");
    expect(getRecord(f.records[0].id)?.status).toBe("completed"); expect(getRecord(f.records[1].id)?.status).toBe("pending");
  });
  it("single-field retries hold the job lock, ignore stale cancel tokens and honour the current job cancel", async () => {
    const f = fixture(); const requested = deferred<AbortSignal>();
    vi.mocked(callModelPool).mockImplementationOnce(async () => {
      const signal = activeSignal();
      requested.resolve(signal);
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const run = analyzeField(f.records[0].id, f.sectionId, "first");
    const check = expect(run).rejects.toThrow("取消"); const signal = await requested.promise;
    expect(() => analyzeJob(f.job.id, f.sectionId)).toThrow("运行");
    cancelAnalysis(f.job.id, "stale-token"); expect(signal.aborted).toBe(false);
    requestJobCancel(f.job.id); await check;
    expect(getJobRunToken(f.job.id)).toBeUndefined(); expect(getRecord(f.records[0].id)?.fieldRuns).toHaveLength(0);
  });
});
