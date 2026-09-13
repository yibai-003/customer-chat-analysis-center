import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../db/client";

export const runOwnership = new AsyncLocalStorage<{ jobId: string; token: string }>();
export function currentRunToken(jobId: string): string | undefined {
  const owner = runOwnership.getStore();
  return owner?.jobId === jobId ? owner.token : undefined;
}
export function assertRunOwnership(jobId?: string) {
  const owner = runOwnership.getStore();
  if (!owner) return;
  if (jobId && jobId !== owner.jobId) throw new Error("任务运行上下文不匹配");
  const row = db.prepare("SELECT run_token FROM jobs WHERE id=?").get(owner.jobId) as { run_token: string | null } | undefined;
  if (row?.run_token !== owner.token) throw new Error("任务运行已失效，拒绝旧运行写入");
}
export function assertRecordOwnership(recordId: string) {
  if (!runOwnership.getStore()) return;
  const row = db.prepare("SELECT job_id FROM records WHERE id=?").get(recordId) as { job_id: string } | undefined;
  if (!row) throw new Error("记录已删除，拒绝旧运行写入");
  assertRunOwnership(row.job_id);
}
