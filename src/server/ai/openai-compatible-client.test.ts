import { describe, expect, it } from "vitest";
import { classifyModelError, extractMessageContent, extractResponseContent } from "./openai-compatible-client";

describe("model error classification", () => {
  it("classifies timeout and authentication failures", () => {
    expect(classifyModelError(new Error("This operation was aborted")).code).toBe("timeout");
    expect(classifyModelError(new Error("401 invalid api key")).code).toBe("auth");
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
