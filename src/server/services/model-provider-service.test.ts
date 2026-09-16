import { beforeAll, describe, expect, it, vi } from "vitest";
import { db, initDb } from "../db/client";
import { requestModel } from "../ai/model-transport";
import {
  createModelConfig,
  listModelConfigs,
  testModelConnection,
  updateModelConfig,
} from "./model-config-service";
import {
  createModelProvider,
  disableModelProvider,
  listModelProviders,
  resolveModelMember,
  resolvePoolMembers,
  testModelProvider,
  updateModelProvider,
} from "./model-provider-service";

vi.mock("../ai/model-transport", () => ({ requestModel: vi.fn() }));

describe("model provider credentials", () => {
  beforeAll(() => initDb());

  it("masks provider keys in public lists and resolves them only for server calls", () => {
    const model = createModelConfig({
      name: "千问凭据解析",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "plain-secret",
      model: "qwen-test",
      purpose: "text",
    });

    const provider = listModelProviders().find((item) => item.id === model.providerId)!;
    expect(provider.maskedApiKey).toMatch(/^\*+/);
    expect(JSON.stringify(listModelProviders())).not.toContain("plain-secret");
    expect(resolveModelMember(model.id)).toMatchObject({
      apiKey: "plain-secret",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      providerId: provider.id,
      providerEnabled: true,
    });
  });

  it("updates provider credentials without clearing member capability data", () => {
    const model = createModelConfig({
      name: "供应商更新保留能力",
      baseUrl: "https://provider-update.example/v1",
      apiKey: "provider-old-secret",
      model: "provider-model",
      purpose: "text",
    });
    db.prepare("UPDATE model_configs SET capability_json=?, capability_checked_at=? WHERE id=?")
      .run(JSON.stringify({ text: true, json: true, vision: false }), Date.now(), model.id);

    updateModelProvider(model.providerId!, { apiKey: "provider-new-secret" });

    expect(listModelConfigs().find((item) => item.id === model.id)?.capabilityStatus).toMatchObject({
      text: true,
      json: true,
    });
    expect(resolveModelMember(model.id).apiKey).toBe("provider-new-secret");
  });

  it("clears member capability data when the linked provider changes", () => {
    const firstProvider = createModelProvider({
      name: "原供应商",
      baseUrl: "https://provider-first.example/v1",
      apiKey: "provider-first-secret",
    });
    const replacementProvider = createModelProvider({
      name: "替换供应商",
      baseUrl: "https://provider-replacement.example/v1",
      apiKey: "provider-replacement-secret",
    });
    const model = createModelConfig({
      name: "供应商切换成员",
      providerId: firstProvider.id,
      baseUrl: "https://unused-reassignment.example/v1",
      model: "provider-reassignment-model",
      purpose: "text",
    });
    db.prepare("UPDATE model_configs SET capability_json=?, capability_checked_at=? WHERE id=?")
      .run(JSON.stringify({ text: true, json: true, vision: false }), Date.now(), model.id);

    updateModelConfig(model.id, { providerId: replacementProvider.id });

    const updated = listModelConfigs().find((item) => item.id === model.id)!;
    expect(updated.providerId).toBe(replacementProvider.id);
    expect(updated.capabilityStatus).toBeUndefined();
    expect(updated.capabilityCheckedAt).toBeUndefined();
  });

  it("clears linked member capability data when a provider endpoint changes", () => {
    const model = createModelConfig({
      name: "供应商端点变更成员",
      baseUrl: "https://provider-endpoint-old.example/v1",
      apiKey: "provider-endpoint-secret",
      model: "provider-endpoint-model",
      purpose: "text",
    });
    db.prepare("UPDATE model_configs SET capability_json=?, capability_checked_at=? WHERE id=?")
      .run(JSON.stringify({ text: true, json: true, vision: false }), Date.now(), model.id);

    updateModelProvider(model.providerId!, { baseUrl: "https://provider-endpoint-new.example/v1" });

    const updated = listModelConfigs().find((item) => item.id === model.id)!;
    expect(updated.baseUrl).toBe("https://provider-endpoint-new.example/v1");
    expect(updated.capabilityStatus).toBeUndefined();
    expect(updated.capabilityCheckedAt).toBeUndefined();
  });

  it("clears member capability data when the model identifier changes", () => {
    const model = createModelConfig({
      name: "模型更新清除能力",
      baseUrl: "https://member-update.example/v1",
      apiKey: "member-secret",
      model: "member-model-old",
      purpose: "text",
    });
    db.prepare("UPDATE model_configs SET capability_json=?, capability_checked_at=? WHERE id=?")
      .run(JSON.stringify({ text: true, json: true, vision: false }), Date.now(), model.id);

    updateModelConfig(model.id, { model: "member-model-new" });

    const updated = listModelConfigs().find((item) => item.id === model.id)!;
    expect(updated.capabilityStatus).toBeUndefined();
    expect(updated.capabilityCheckedAt).toBeUndefined();
  });

  it("creates, updates, disables, and resolves enabled pool providers without exposing keys", () => {
    const provider = createModelProvider({
      name: "独立供应商",
      baseUrl: "https://standalone.example/v1",
      apiKey: "standalone-secret",
    });
    expect(JSON.stringify(provider)).not.toContain("standalone-secret");

    const model = createModelConfig({
      name: "独立供应商成员",
      providerId: provider.id,
      baseUrl: "https://legacy-placeholder.example/v1",
      apiKey: "legacy-placeholder-secret",
      model: "standalone-model",
      purpose: "text",
    });
    db.prepare("UPDATE model_configs SET pool_enabled=1 WHERE id=?").run(model.id);

    expect(resolvePoolMembers("text").some((item) =>
      item.id === model.id && item.apiKey === "standalone-secret" && item.baseUrl === "https://standalone.example/v1"
    )).toBe(true);

    const updated = updateModelProvider(provider.id, { name: "独立供应商更新" });
    expect(updated.name).toBe("独立供应商更新");
    disableModelProvider(provider.id, "manual disable");
    expect(listModelProviders().find((item) => item.id === provider.id)).toMatchObject({
      isEnabled: false,
      lastError: "manual disable",
    });
    expect(resolvePoolMembers("text").some((item) => item.id === model.id)).toBe(false);
  });

  it("tests a provider through an enabled member and records the public result", async () => {
    const provider = createModelProvider({
      name: "连接测试供应商",
      baseUrl: "https://provider-test.example/v1",
      apiKey: "provider-test-secret",
    });
    createModelConfig({
      name: "连接测试成员",
      providerId: provider.id,
      baseUrl: "https://unused.example/v1",
      model: "provider-test-model",
      purpose: "text",
    });
    vi.mocked(requestModel).mockResolvedValueOnce({
      response: new Response("", { status: 200 }),
      rawText: JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
      attemptsUsed: 1,
    });

    await expect(testModelProvider(provider.id)).resolves.toMatchObject({ success: true });
    const tested = listModelProviders().find((item) => item.id === provider.id)!;
    expect(tested.lastTestedAt).toBeTruthy();
    expect(tested.lastError).toBeUndefined();
    expect(JSON.stringify(tested)).not.toContain("provider-test-secret");
  });

  it("does not persist or return a provider error that echoes the API key", async () => {
    const provider = createModelProvider({
      name: "错误脱敏供应商",
      baseUrl: "https://provider-error.example/v1",
      apiKey: "echoed-provider-secret",
    });
    createModelConfig({
      name: "错误脱敏成员",
      providerId: provider.id,
      baseUrl: "https://unused-error.example/v1",
      model: "provider-error-model",
      purpose: "text",
    });
    vi.mocked(requestModel).mockResolvedValueOnce({
      response: new Response("", { status: 401 }),
      rawText: JSON.stringify({ error: { message: "invalid key echoed-provider-secret" } }),
      attemptsUsed: 1,
    });

    let returnedMessage = "";
    try {
      await testModelProvider(provider.id);
    } catch (error) {
      returnedMessage = error instanceof Error ? error.message : String(error);
    }

    expect(returnedMessage).not.toContain("echoed-provider-secret");
    expect(JSON.stringify(listModelProviders().find((item) => item.id === provider.id))).not.toContain(
      "echoed-provider-secret",
    );
  });

  it("redacts an echoed API key from legacy model connection errors", async () => {
    const model = createModelConfig({
      name: "旧连接测试脱敏",
      baseUrl: "https://legacy-error.example/v1",
      apiKey: "legacy-echoed-secret",
      model: "legacy-error-model",
      purpose: "text",
    });
    vi.mocked(requestModel).mockResolvedValueOnce({
      response: new Response("", { status: 401 }),
      rawText: JSON.stringify({ error: { message: "invalid key legacy-echoed-secret" } }),
      attemptsUsed: 1,
    });

    let returnedMessage = "";
    try {
      await testModelConnection(model.id);
    } catch (error) {
      returnedMessage = error instanceof Error ? error.message : String(error);
    }

    expect(returnedMessage).not.toContain("legacy-echoed-secret");
  });

  it("redacts the provider API key from a persisted disable reason", () => {
    const provider = createModelProvider({
      name: "停用原因脱敏",
      baseUrl: "https://disable-reason.example/v1",
      apiKey: "disable-reason-secret",
    });

    const disabled = disableModelProvider(
      provider.id,
      "manual disable after key disable-reason-secret was rejected",
    );

    expect(disabled.lastError).not.toContain("disable-reason-secret");
    expect(JSON.stringify(listModelProviders().find((item) => item.id === provider.id))).not.toContain(
      "disable-reason-secret",
    );
  });
});
