import { afterEach, describe, expect, it, vi } from "vitest";
import { requestModel } from "./model-transport";
import { createServer } from "node:http";
import { callVisionModel } from "./openai-compatible-client";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("bounded model transport", () => {
  it("shares the three-attempt budget across JSON compatibility fallback", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"response_format unsupported"}}', { status: 400 }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })));
    vi.stubGlobal("fetch", fetcher);
    const p = callVisionModel({ baseUrl: "https://model.test/v1", model: "test", apiKey: "test", maxTokens: 100, temperature: 0 }, [{ role: "user", content: "Return json" }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p).content).toBe('{"ok":true}');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).response_format).toBeUndefined();
  });
  it("aborts a real response stream that stalls after its headers", async () => {
    const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.flushHeaders(); res.write('{"partial":'); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      await expect(requestModel(`http://127.0.0.1:${address.port}`, {}, { timeoutMs: 100, attempts: 1 })).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it("retries network and server errors after 5s and 15s", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetcher);
    const p = requestModel("https://model.test", {});
    await vi.advanceTimersByTimeAsync(4999); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15000); expect((await p).rawText).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("times out after headers while waiting for the body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => ({
      text: () => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })),
    })));
    const p = requestModel("https://model.test", {}, { timeoutMs: 100, attempts: 1 });
    const check = expect(p).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100); await check;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not retry authentication or certificate failures", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    expect((await requestModel("https://model.test", {})).response.status).toBe(401);
    fetcher.mockRejectedValueOnce(new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } }));
    await expect(requestModel("https://model.test", {})).rejects.toThrow("fetch failed");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("cancels retry waiting without starting another paid request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValue(new Response("busy", { status: 429 }));
    vi.stubGlobal("fetch", fetcher);
    const p = requestModel("https://model.test", {}, { signal: controller.signal });
    const check = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10); controller.abort(); await check;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
