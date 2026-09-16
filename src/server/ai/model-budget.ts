import { AsyncLocalStorage } from "node:async_hooks";
import { analysisSignal } from "../services/analysis-cancellation";

export class ModelBudgetExceeded extends Error {
  constructor(requests = 6, message?: string) {
    super(message ?? `模型请求已达到总预算（最多 ${requests} 次请求、5 分钟），请检查配置后重试`);
  }
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

export interface PaidTokenBudget {
  reservePaidTokens: (tokens: number) => void;
  settlePaidTokens: (reserved: number, actual: number) => void;
  paidTokensUsed: () => number;
}

interface PaidTokenBudgetContext extends PaidTokenBudget {
  maxPaidTokens: number;
}

const paidTokenContext = new AsyncLocalStorage<PaidTokenBudgetContext>();

function validTokenCount(tokens: number) {
  return Number.isSafeInteger(tokens) && tokens >= 0;
}

export function currentPaidTokenBudget(): PaidTokenBudget | undefined {
  return paidTokenContext.getStore();
}

export function paidTokensUsed(): number {
  return paidTokenContext.getStore()?.paidTokensUsed() ?? 0;
}

export function paidTokensRemaining(): number {
  const budget = paidTokenContext.getStore();
  return budget ? budget.maxPaidTokens - budget.paidTokensUsed() : 0;
}

export async function withPaidTokenBudget<T>(
  work: () => Promise<T>,
  options: { maxPaidTokens?: number } = {},
): Promise<T> {
  if (paidTokenContext.getStore()) return work();
  const maxPaidTokens = options.maxPaidTokens ?? 0;
  if (!validTokenCount(maxPaidTokens)) throw new Error("Invalid paid token budget");
  let used = 0;
  const budget: PaidTokenBudgetContext = {
    maxPaidTokens,
    reservePaidTokens(tokens) {
      if (!validTokenCount(tokens)) throw new Error("Invalid paid token reservation");
      if (used + tokens > maxPaidTokens) {
        throw new ModelBudgetExceeded(
          6,
          `付费 Token 预算不足（已用 ${used}，请求预留 ${tokens}，上限 ${maxPaidTokens}）`,
        );
      }
      used += tokens;
    },
    settlePaidTokens(reserved, actual) {
      if (!validTokenCount(reserved) || !validTokenCount(actual) || reserved > used) {
        throw new Error("Invalid paid token settlement");
      }
      if (used - reserved + actual > maxPaidTokens) {
        throw new ModelBudgetExceeded(
          6,
          `付费 Token 预算不足（实际用量 ${actual} 超过上限 ${maxPaidTokens}）`,
        );
      }
      used += actual - reserved;
    },
    paidTokensUsed: () => used,
  };
  return paidTokenContext.run(budget, work);
}
