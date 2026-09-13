import { acquireJobRun, assertJobSection, getAnalysisProgressBaseline, getJob, getJobRunToken, getRecord, releaseJobRun, settleCancelledRecord, touchJobRun, updateRecord } from "../db/repositories";
import { runOwnership, assertRecordOwnership } from "./run-ownership";
import { analysisSignal, withAnalysisCancellation } from "./analysis-cancellation";

/** Single-record and field retries obey the same ownership/cancellation boundary as batches. */
export async function withSingleAnalysisRun<T>(recordId: string, sectionId: string, work: () => Promise<T>) {
  if (runOwnership.getStore()) { assertRecordOwnership(recordId); return work(); }
  const record = getRecord(recordId);
  if (!record) throw new Error("记录不存在");
  assertJobSection(record.jobId, sectionId);
  if (!acquireJobRun(record.jobId)) throw new Error("任务正在运行或当前状态不允许解析");
  const token = getJobRunToken(record.jobId)!;
  return withAnalysisCancellation(record.jobId, token, () => runOwnership.run({ jobId: record.jobId, token }, async () => {
    const timer = setInterval(() => touchJobRun(record.jobId, token), 10_000);
    let failed = false;
    try { return await work(); }
    catch (error) {
      failed = true;
      if (analysisSignal()?.aborted) settleCancelledRecord(recordId, record.jobId, token);
      else if (getRecord(recordId)?.status === "processing") updateRecord(recordId, { status: "failed", reviewStatus: "needs_review" });
      throw error;
    } finally {
      clearInterval(timer);
      const job = getJob(record.jobId);
      if (job) {
        const progress = getAnalysisProgressBaseline(record.jobId, sectionId);
        const status = job.status === "cancelled" || job.status === "paused" ? job.status
          : failed || progress.failed > 0 ? "failed" : progress.pending > 0 || progress.processing > 0 ? "paused" : "completed";
        releaseJobRun(record.jobId, status, token);
      }
    }
  }));
}
