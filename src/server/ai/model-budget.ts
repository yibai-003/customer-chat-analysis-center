import { AsyncLocalStorage } from "node:async_hooks";
import { analysisSignal } from "../services/analysis-cancellation";

export class ModelBudgetExceeded extends Error {
  constructor(requests = 6) { super(`模型请求已达到总预算（最多 ${requests} 次请求、5 分钟），请检查配置后重试`); }
}
export interface ModelBudget { signal: AbortSignal; consume: () => void; check: () => void }
const context = new AsyncLocalStorage<ModelBudget>();
export function currentModelBudget() { return context.getStore(); }
export function checkModelBudget() { context.getStore()?.check(); }
export async function withModelBudget<T>(work: () => Promise<T>, options: { signal?: AbortSignal; requests?: number; timeoutMs?: number } = {}) {
  if (context.getStore()) return work();
  const requests = options.requests ?? 6;
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(requests) || requests < 1 || requests > 6 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new Error("Invalid model budget");
  const deadline = new AbortController();
  const parent = options.signal ?? analysisSignal();
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(new ModelBudgetExceeded(requests)), timeoutMs);
  let used = 0;
  const budget: ModelBudget = {
    signal,
    check: () => { signal.throwIfAborted(); if (used >= requests) throw new ModelBudgetExceeded(requests); },
    consume: () => { budget.check(); used++; },
  };
  try { return await context.run(budget, work); }
  finally { clearTimeout(timer); }
}
