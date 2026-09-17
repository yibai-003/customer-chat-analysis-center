import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callVisionModel,
  classifyModelError,
  extractMessageContent,
  extractResponseContent,
} from "./openai-compatible-client";

afterEach(() => vi.unstubAllGlobals());

describe("model error classification", () => {
  it("classifies cancellation, timeout, authentication, and budget failures", () => {
    expect(classifyModelError(new DOMException("cancelled", "AbortError")).code).toBe("cancelled");
    expect(classifyModelError(new DOMException("timed out", "TimeoutError")).code).toBe("timeout");
    expect(classifyModelError(new Error("401 invalid api key")).code).toBe("auth");
    expect(classifyModelError(new Error("模型请求已达到总预算")).code).toBe("budget");
  });

  it("classifies provider failures into exact routing categories", () => {
    expect(classifyModelError(new Error("busy (503)"))).toMatchObject({
      code: "service", retryable: true, httpStatus: 503,
    });
    expect(classifyModelError(new Error("request timeout (408)"))).toMatchObject({
      code: "timeout", retryable: true, httpStatus: 408,
    });
    expect(classifyModelError(new Error("rate limited (429)"))).toMatchObject({
      code: "rate_limit", retryable: true, httpStatus: 429,
    });
    expect(classifyModelError(new Error("bad request (400)"))).toMatchObject({
      code: "model", retryable: false, httpStatus: 400,
    });
    expect(classifyModelError(new Error("model not found (404)"))).toMatchObject({
      code: "model", retryable: false, httpStatus: 404,
    });
    expect(classifyModelError(new Error("request timeout (401)"))).toMatchObject({
      code: "auth", retryable: false, httpStatus: 401,
    });
    expect(classifyModelError(new Error("接口地址返回了网页内容"))).toMatchObject({
      code: "configuration", retryable: false,
    });
  });

  it.each([
    "insufficient_quota (429)",
    "quota exhausted (429)",
    "free quota has been used (429)",
    "余额不足 (429)",
    "额度用尽 (429)",
  ])("detects quota exhaustion before generic rate limiting: %s", (message) => {
    expect(classifyModelError(new Error(message))).toMatchObject({
      code: "quota_exhausted",
      retryable: false,
      httpStatus: 429,
    });
  });

  it("preserves the HTTP status when the model returns a JSON error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '{"error":{"message":"busy"}}',
      { status: 503, headers: { "Content-Type": "application/json" } },
    )));

    await expect(callVisionModel({
      baseUrl: "https://model.test/v1",
      apiKey: "test",
      model: "test",
      temperature: 0,
      maxTokens: 100,
    }, [], { attempts: 1 })).rejects.toThrow("busy (503)");
  });

  it("classifies HTTP service failures as retryable without retrying permanent errors", () => {
    expect(classifyModelError(new Error("busy (503)")).retryable).toBe(true);
    expect(classifyModelError(new Error("rate limited (429)")).retryable).toBe(true);
    expect(classifyModelError(new Error("request timeout (401)")).retryable).toBe(false);
    expect(classifyModelError(new Error("bad request (400)")).retryable).toBe(false);
    expect(classifyModelError(new Error("model not found (404)")).retryable).toBe(false);
  });

  it("preserves the HTTP status when the model returns a JSON error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '{"error":{"message":"busy"}}',
      { status: 503, headers: { "Content-Type": "application/json" } },
    )));

    await expect(callVisionModel({
      baseUrl: "https://model.test/v1",
      apiKey: "test",
      model: "test",
      temperature: 0,
      maxTokens: 100,
    }, [], { attempts: 1 })).rejects.toThrow("busy (503)");
  });

  it("extracts text from string and multimodal message content", () => {
    expect(extractMessageContent({ content: "ok" })).toBe("ok");
    expect(extractMessageContent({ content: [{ type: "text", text: "ok" }] })).toBe("ok");
    expect(extractMessageContent({ content: { type: "text", text: "ok" } })).toBe("ok");
    expect(extractMessageContent({ text: "ok" })).toBe("ok");
    expect(extractMessageContent({ output_text: "ok" })).toBe("ok");
  });

  it("extracts text from chat and responses-style envelopes", () => {
    expect(extractResponseContent({ choices: [{ message: { content: "ok" } }] })).toBe("ok");
    expect(extractResponseContent({ output_text: "ok" })).toBe("ok");
    expect(extractResponseContent({ output: [{ content: [{ type: "output_text", text: "ok" }] }] })).toBe("ok");
    expect(extractResponseContent("ok")).toBe("ok");
  });

  it("preserves only optional non-negative integer usage fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: -1,
        total_tokens: 999,
      },
    }), { status: 200 })));

    await expect(callVisionModel({
      baseUrl: "https://model.test/v1",
      apiKey: "test",
      model: "test",
      temperature: 0,
      maxTokens: 100,
    }, [], { attempts: 1 })).resolves.toMatchObject({
      usage: { prompt_tokens: 12 },
    });
    const result = await callVisionModel({
      baseUrl: "https://model.test/v1",
      apiKey: "test",
      model: "test",
      temperature: 0,
      maxTokens: 100,
    }, [], { attempts: 1 });
    expect(result.usage).toEqual({ prompt_tokens: 12 });
  });
});
