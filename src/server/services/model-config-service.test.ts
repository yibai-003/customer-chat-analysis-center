import { beforeAll, describe, expect, it } from "vitest";
import { initDb } from "../db/client";
import { createModelConfig, deleteModelConfig, getModelsForPurpose, listModelConfigs, setDefaultModel, updateModelConfig } from "./model-config-service";
import { listModelProviders, resolveModelMember } from "./model-provider-service";

describe("model configuration management", () => {
  beforeAll(() => initDb());

  it("updates an existing configuration without returning the API key", () => {
    const created = createModelConfig({
      name: "更新测试",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-original",
      model: "vision-a",
    });
    const updated = updateModelConfig(created.id, {
      name: "更新后的模型",
      model: "vision-b",
      apiKey: "sk-updated",
    });
    expect(updated.name).toBe("更新后的模型");
    expect(updated.model).toBe("vision-b");
    expect(updated.maskedApiKey).toBe("sk-u****ated");
    expect(JSON.stringify(updated)).not.toContain("sk-updated");
  });

  it("automatically promotes a replacement when deleting a purpose default", () => {
    const created = createModelConfig({
      name: "默认删除测试",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-default",
      model: "vision-a",
      purpose: "vision",
    });
    const replacement = createModelConfig({
      name: "备用视觉模型",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-replacement",
      model: "vision-b",
      purpose: "vision",
    });
    setDefaultModel(created.id);
    deleteModelConfig(created.id);
    expect(listModelConfigs().find((model) => model.id === replacement.id)?.isPurposeDefault).toBe(true);
  });

  it("orders enabled models with the purpose default first", () => {
    const primary = createModelConfig({
      name: "主视觉模型",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-primary",
      model: "vision-primary",
      purpose: "vision",
    });
    createModelConfig({
      name: "备用视觉模型",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-backup",
      model: "vision-backup",
      purpose: "vision",
    });
    setDefaultModel(primary.id, "vision");
    expect(getModelsForPurpose("vision")[0].id).toBe(primary.id);
  });

  it("returns concrete pool metadata defaults for legacy model configurations", () => {
    const created = createModelConfig({
      name: "池元数据默认值",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-pool-defaults",
      model: "text-defaults",
      purpose: "text",
      supportsVision: false,
    });

    expect(created).toMatchObject({
      poolEnabled: false,
      billingMode: "paid",
      qualityTier: "A",
      priority: 100,
      thinkingMode: false,
      memberType: "general",
      quotaUsedTokens: 0,
      quotaSafetyRatio: 0.95,
      consecutiveFailures: 0,
      capabilityEligible: false,
      quotaBlocked: false,
    });
  });

  it("reuses a provider only when base URL and decrypted key both match", () => {
    const first = createModelConfig({
      name: "共享供应商一",
      baseUrl: "https://provider-reuse.example/v1",
      apiKey: "same-provider-secret",
      model: "shared-model-a",
      purpose: "text",
    });
    const second = createModelConfig({
      name: "共享供应商二",
      baseUrl: "https://provider-reuse.example/v1",
      apiKey: "same-provider-secret",
      model: "shared-model-b",
      purpose: "text",
    });
    const differentKey = createModelConfig({
      name: "不同密钥供应商",
      baseUrl: "https://provider-reuse.example/v1",
      apiKey: "different-provider-secret",
      model: "shared-model-c",
      purpose: "text",
    });

    expect(second.providerId).toBe(first.providerId);
    expect(differentKey.providerId).not.toBe(first.providerId);
    expect(listModelProviders().filter((provider) => provider.baseUrl === "https://provider-reuse.example/v1")).toHaveLength(2);
  });

  it("updates linked provider credentials only when legacy credential fields are explicit", () => {
    const created = createModelConfig({
      name: "显式凭据更新",
      baseUrl: "https://explicit-provider.example/v1",
      apiKey: "explicit-old-secret",
      model: "explicit-model",
      purpose: "text",
    });

    updateModelConfig(created.id, { name: "仅改名称" });
    expect(resolveModelMember(created.id)).toMatchObject({
      apiKey: "explicit-old-secret",
      baseUrl: "https://explicit-provider.example/v1",
    });

    updateModelConfig(created.id, {
      baseUrl: "https://explicit-provider-new.example/v1",
      apiKey: "explicit-new-secret",
    });
    expect(resolveModelMember(created.id)).toMatchObject({
      apiKey: "explicit-new-secret",
      baseUrl: "https://explicit-provider-new.example/v1",
    });
  });
});
