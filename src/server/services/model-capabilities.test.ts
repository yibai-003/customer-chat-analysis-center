import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDb } from "../db/client";
import { createModelConfig, updateModelConfig, listModelConfigs, testModelCapabilities, modelVerification } from "./model-config-service";
import { requestModel } from "../ai/model-transport";
vi.mock("../ai/model-transport", () => ({ requestModel: vi.fn() }));
beforeEach(() => { initDb(); vi.mocked(requestModel).mockReset(); });
afterEach(() => vi.useRealTimers());
const response = (content: string) => ({ response: new Response(""), rawText: JSON.stringify({ choices: [{ message: { content } }] }), attemptsUsed: 1 });
const create = (vision = false) => createModelConfig({ name: "test", model: "test-model", apiKey: "sk-private-test", baseUrl: "https://example.com/v1", purpose: vision ? "vision" : "text", supportsVision: vision });
function success(vision = false) {
  vi.mocked(requestModel).mockResolvedValueOnce(response("OK")).mockResolvedValueOnce(response('{"ok":true}'));
  if (vision) vi.mocked(requestModel).mockResolvedValueOnce(response("red"));
}
describe("persisted model diagnostics", () => {
  it("probes text and JSON separately, sends an actual image, and persists results", async () => {
    const m = create(true); success(true);
    expect((await testModelCapabilities(m.id)).capabilities).toMatchObject({ text: true, json: true, vision: true });
    const calls = vi.mocked(requestModel).mock.calls;
    expect(JSON.parse(calls[0][1].body as string).response_format).toBeUndefined();
    expect(JSON.parse(calls[1][1].body as string).response_format.type).toBe("json_object");
    expect(JSON.parse(calls[2][1].body as string).messages[0].content[1].image_url.url).toContain("data:image/png;base64,");
    const saved = listModelConfigs().find(x => x.id === m.id)!;
    expect(modelVerification(saved).state).toBe("passed");
    expect(JSON.stringify(saved)).not.toContain("sk-private-test");
    updateModelConfig(m.id, { model: "changed-model" });
    expect(modelVerification(listModelConfigs().find(x => x.id === m.id)).state).toBe("untested");
  });
  it.each(["null", "[]", "{}", '{"ok":false}'])("rejects invalid JSON result %s", async content => {
    const m = create(); vi.mocked(requestModel).mockResolvedValueOnce(response("OK")).mockResolvedValueOnce(response(content));
    expect((await testModelCapabilities(m.id)).capabilities.json).toBe(false);
    expect(modelVerification(listModelConfigs().find(x => x.id === m.id)).state).toBe("failed");
  });
  it("a failed check replaces a prior successful result and does not persist provider secrets", async () => {
    const m = create(); success(); await testModelCapabilities(m.id);
    vi.mocked(requestModel).mockRejectedValue(new Error("sk-private-test connection failed"));
    const result = await testModelCapabilities(m.id);
    expect(result.capabilities.text).toBe(false);
    expect(modelVerification(listModelConfigs().find(x => x.id === m.id)).verified).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sk-private-test");
  });
  it("does not accept a generic OK as vision support", async () => {
    const m = create(true); success(); vi.mocked(requestModel).mockResolvedValueOnce(response("OK"));
    expect((await testModelCapabilities(m.id)).capabilities.vision).toBe(false);
  });
  it("does not save stale results after config changes during a check", async () => {
    const m = create();
    let release!: (v: ReturnType<typeof response>) => void;
    vi.mocked(requestModel).mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce(response('{"ok":true}'));
    const p = testModelCapabilities(m.id);
    expect(testModelCapabilities(m.id)).toBe(p);
    updateModelConfig(m.id, { apiKey: "sk-new-private" });
    release(response("OK"));
    await expect(p).rejects.toThrow("配置已变更");
    expect(modelVerification(listModelConfigs().find(x => x.id === m.id)).state).toBe("untested");
  });
  it("expires old checks without making a network request", async () => {
    const m = create(); success(); await testModelCapabilities(m.id);
    const saved = listModelConfigs().find(x => x.id === m.id)!;
    expect(modelVerification(saved, Date.parse(saved.capabilityCheckedAt!) + 86400001).state).toBe("expired");
    expect(requestModel).toHaveBeenCalledTimes(2);
  });
});
