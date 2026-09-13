import { AsyncLocalStorage } from "node:async_hooks";

const active = new Map<string, { token: string; controller: AbortController }>();
const context = new AsyncLocalStorage<AbortSignal>();
export function analysisSignal() { return context.getStore(); }
export function assertAnalysisActive() { analysisSignal()?.throwIfAborted(); }
export function cancelAnalysis(jobId: string, token?: string) {
  const run = active.get(jobId);
  if (run && run.token === token) run.controller.abort(new DOMException("任务已取消", "AbortError"));
}
export async function withAnalysisCancellation<T>(jobId: string, token: string, work: () => Promise<T>) {
  if (active.has(jobId)) throw new Error("任务已有取消上下文");
  const controller = new AbortController(); active.set(jobId, { token, controller });
  try { return await context.run(controller.signal, work); }
  finally { if (active.get(jobId)?.token === token) active.delete(jobId); }
}
