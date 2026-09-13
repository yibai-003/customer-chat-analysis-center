import { afterEach, describe, expect, it, vi } from "vitest";
import { callVisionModel } from "./openai-compatible-client";
import { withModelBudget, checkModelBudget } from "./model-budget";
const model = { baseUrl: "https://budget.test/v1", apiKey: "test", model: "test", temperature: 0, maxTokens: 100 };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("shared model budget", () => {
  it("caps JSON fallback and multiple candidate models together, including failed network attempts", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockRejectedValue(new TypeError("fetch failed")); vi.stubGlobal("fetch", fetcher);
    const result = withModelBudget(async () => {
      for (let candidate = 0; candidate < 5; candidate++) {
        checkModelBudget();
        try { await callVisionModel({ ...model, model: String(candidate) }, []); } catch { /* try next within budget */ }
      }
    });
    const check = expect(result).rejects.toThrow("总预算");
    await vi.runAllTimersAsync(); await check;
    expect(fetcher).toHaveBeenCalledTimes(6); expect(vi.getTimerCount()).toBe(0);
  });
  it("shares the deadline across calls and interrupts a stalled body without starting another candidate", async () => {
    vi.useFakeTimers(); let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      return { text: () => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })) };
    }));
    const result = withModelBudget(async () => { await callVisionModel(model, []); await callVisionModel(model, []); }, { timeoutMs: 100 });
    const check = expect(result).rejects.toThrow("总预算"); await vi.advanceTimersByTimeAsync(100); await check;
    expect(calls).toBe(2); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not grant a fresh request allowance for JSON format downgrade", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('{"error":{"message":"response_format unsupported"}}', { status: 400 })); vi.stubGlobal("fetch", fetcher);
    await expect(withModelBudget(() => callVisionModel(model, []), { requests: 1 })).rejects.toThrow("总预算");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
