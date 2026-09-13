import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, initDb } from "../db/client";
import { addRecords, createJob, getJob, getJobRunToken, getRecord, listRecords, requestJobCancel, requestJobPause, upsertSection } from "../db/repositories";
import { upsertField } from "./field-config-service";
import { createModelConfig } from "./model-config-service";
import { analyzeJob } from "./batch-analysis-service";
import { analyzeField } from "./field-analysis-service";
import { cancelAnalysis } from "./analysis-cancellation";
import { withSingleAnalysisRun } from "./single-analysis-run";
import { updateRecord } from "../db/repositories";

beforeAll(() => initDb());
afterEach(() => vi.unstubAllGlobals());
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
function fixture(baseUrl = "https://cancel.test/v1") {
  db.exec("DELETE FROM model_configs");
  createModelConfig({ name: "test", baseUrl, apiKey: "not-real", model: "local", purpose: "text", supportsVision: false });
  const sectionId = randomUUID(); upsertSection({ id: sectionId, name: "cancel", prompt: "", outputSchema: [] });
  const fields = ["first", "second"].map((key, index) => upsertField({ sectionId, key, label: key, type: "string", imageEnabled: false, sortOrder: index }));
  const job = createJob("cancel.xlsx", "unused", { id: sectionId, name: "cancel" });
  addRecords(job.id, [1, 2].map(rowNumber => ({ rowNumber, sheetName: "s", anchor: {}, sourceFields: {}, imagePath: "unused" })));
  return { sectionId, job, fields, records: listRecords(job.id) };
}
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"first":"ok","second":"ok"}' } }] }));
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

describe("actual analysis cancellation", () => {
  it("settles single-record infrastructure errors instead of leaving a processing row", async () => {
    const f = fixture();
    await expect(withSingleAnalysisRun(f.records[0].id, f.sectionId, async () => {
      updateRecord(f.records[0].id, { status: "processing" }); throw new Error("queue timeout");
    })).rejects.toThrow("queue timeout");
    expect(getRecord(f.records[0].id)?.status).toBe("failed"); expect(getJobRunToken(f.job.id)).toBeUndefined();
  });
  it("closes a real stalled response stream, leaves no processing rows, and never starts later fields or records", async () => {
    const requested = deferred<void>(); const disconnected = deferred<void>(); let count = 0;
    const server = createServer((_req, res) => {
      count++; res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"choices":');
      res.once("close", () => disconnected.resolve()); requested.resolve();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const f = fixture(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
    const run = analyzeJob(f.job.id, f.sectionId, { concurrency: 1, batchSize: 5 });
    try {
      await requested.promise; requestJobCancel(f.job.id); await run; await disconnected.promise;
      expect(count).toBe(1); expect(getJob(f.job.id)?.status).toBe("cancelled");
      expect(getJobRunToken(f.job.id)).toBeUndefined();
      for (const record of f.records) expect(getRecord(record.id)).toMatchObject({ status: "pending", fieldRuns: [] });
    } finally { await close(server); }
  });
  it("rejects a late response that ignores abort, retains committed fields, and can start a fresh run", async () => {
    const f = fixture(); const requested = deferred<void>(); const late = deferred<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(success()).mockImplementationOnce(() => { requested.resolve(); return late.promise; });
    vi.stubGlobal("fetch", fetcher);
    const run = analyzeJob(f.job.id, f.sectionId, { concurrency: 1 });
    await requested.promise; requestJobCancel(f.job.id); late.resolve(success()); await run;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getRecord(f.records[0].id)?.fieldRuns).toHaveLength(1);
    expect(getRecord(f.records[0].id)?.fieldRuns[0].fieldKey).toBe("first");
    expect(getRecord(f.records[0].id)?.status).toBe("pending");
    fetcher.mockImplementation(async () => success());
    await analyzeJob(f.job.id, f.sectionId, { concurrency: 1 });
    expect(getJob(f.job.id)?.status).toBe("completed");
  });
  it("pause completes the in-flight record but does not begin the next record", async () => {
    const f = fixture(); const requested = deferred<void>(); const response = deferred<Response>();
    const fetcher = vi.fn().mockImplementationOnce(() => { requested.resolve(); return response.promise; }).mockImplementation(async () => success());
    vi.stubGlobal("fetch", fetcher);
    const run = analyzeJob(f.job.id, f.sectionId, { concurrency: 1 });
    await requested.promise; requestJobPause(f.job.id); response.resolve(success()); await run;
    expect(fetcher).toHaveBeenCalledTimes(2); expect(getJob(f.job.id)?.status).toBe("paused");
    expect(getRecord(f.records[0].id)?.status).toBe("completed"); expect(getRecord(f.records[1].id)?.status).toBe("pending");
  });
  it("single-field retries hold the job lock, ignore stale cancel tokens and honour the current job cancel", async () => {
    const f = fixture(); const requested = deferred<AbortSignal>();
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requested.resolve(init.signal);
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    }));
    const run = analyzeField(f.records[0].id, f.sectionId, "first");
    const check = expect(run).rejects.toThrow("取消"); const signal = await requested.promise;
    expect(() => analyzeJob(f.job.id, f.sectionId)).toThrow("运行");
    cancelAnalysis(f.job.id, "stale-token"); expect(signal.aborted).toBe(false);
    requestJobCancel(f.job.id); await check;
    expect(getJobRunToken(f.job.id)).toBeUndefined(); expect(getRecord(f.records[0].id)?.fieldRuns).toHaveLength(0);
  });
});
