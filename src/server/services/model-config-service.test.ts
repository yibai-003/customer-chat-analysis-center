import { beforeAll, describe, expect, it } from "vitest";
import { initDb } from "../db/client";
import { createModelConfig, deleteModelConfig, getModelsForPurpose, listModelConfigs, setDefaultModel, updateModelConfig } from "./model-config-service";

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
});
