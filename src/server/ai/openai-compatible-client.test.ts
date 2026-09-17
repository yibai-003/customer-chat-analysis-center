import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callVisionModel,
  classifyModelError,
  extractMessageContent,
  extractResponseContent,
} from "./openai-compatible-client";

afterEach(() => vi.unstubAllGlobals());

describe("model error classification", () => {
  it("classifies timeout and authentication failures", () => {
    expect(classifyModelError(new Error("This operation was aborted")).code).toBe("timeout");
    expect(classifyModelError(new Error("401 invalid api key")).code).toBe("auth");
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
});
