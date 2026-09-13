import { beforeAll, describe, expect, it } from "vitest";
import { db, initDb } from "../db/client";
import { acquireJobRun, addRecords, createJob, getJob, getJobRunToken, getRecord, listRecords, recoverStaleJobRuns, releaseJobRun, requestJobPause, touchJobRun, updateRecord } from "../db/repositories";
import { createFieldRun } from "./field-run-service";
import { runOwnership } from "./run-ownership";
beforeAll(() => initDb());
function fixture() {
  const job = createJob("run.xlsx", "run.xlsx", { id: "refund", name: "refund" });
  addRecords(job.id, [{ rowNumber: 1, sheetName: "Sheet1", sourceFields: {}, anchor: {}, imagePath: "unused.png" }]);
  return { job, record: listRecords(job.id)[0] };
}
describe("run ownership and recovery", () => {
  it("recovers recent locks and processing records immediately, preserving completed work and paused intent", () => {
    const { job, record } = fixture();
    acquireJobRun(job.id);
    updateRecord(record.id, { status: "processing" });
    const paused = fixture(); acquireJobRun(paused.job.id); requestJobPause(paused.job.id);
    expect(recoverStaleJobRuns()).toBeGreaterThanOrEqual(2);
    expect(getJob(job.id)).toMatchObject({ status: "failed", failedRecords: 1, processingRecords: 0 });
    expect(getRecord(record.id)?.status).toBe("failed");
    expect(getJob(paused.job.id)?.status).toBe("paused");
    expect(getJobRunToken(job.id)).toBeUndefined();
    expect(acquireJobRun(job.id)).toBe(true);
    releaseJobRun(job.id, "paused");
  });
  it("old tokens cannot heartbeat, release, or write field/record results after a new run starts", () => {
    const { job, record } = fixture(); acquireJobRun(job.id);
    const old = getJobRunToken(job.id)!;
    releaseJobRun(job.id, "paused", old); acquireJobRun(job.id);
    const fresh = getJobRunToken(job.id)!;
    expect(touchJobRun(job.id, old)).toBe(false);
    expect(touchJobRun(job.id, fresh)).toBe(true);
    releaseJobRun(job.id, "completed", old);
    expect(getJobRunToken(job.id)).toBe(fresh);
    runOwnership.run({ jobId: job.id, token: old }, () => {
      expect(() => updateRecord(record.id, { status: "completed" })).toThrow("失效");
      expect(() => createFieldRun({ recordId: record.id, fieldId: "legacy-refund-reason", status: "completed" })).toThrow("失效");
      releaseJobRun(job.id, "completed");
    });
    expect(getJobRunToken(job.id)).toBe(fresh);
    expect(getRecord(record.id)?.status).toBe("pending");
    releaseJobRun(job.id, "paused", fresh);
    const times = db.prepare("SELECT run_started_at,heartbeat_at,run_finished_at FROM jobs WHERE id=?").get(job.id);
    expect(times.run_started_at).toBeTypeOf("number"); expect(times.heartbeat_at).toBeTypeOf("number"); expect(times.run_finished_at).toBeTypeOf("number");
  });
});
