import fs from "node:fs";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { config } from "../config";
import { db, initDb } from "../db/client";
import {
  createModelConfig,
  deleteModelConfig,
  getModelReadinessActions,
  getModelReadinessChecks,
  getModelsForPurpose,
  listModelConfigs,
  setDefaultModel,
  updateModelConfig,
} from "./model-config-service";
import { listModelProviders, resolveModelMember } from "./model-provider-service";

describe("model configuration management", () => {
  beforeEach(() => {
    initDb();
    db.exec(`
      DELETE FROM model_usage_events;
      DELETE FROM model_configs;
      DELETE FROM model_providers;
    `);
    db.prepare(`UPDATE model_pool_settings SET paid_daily_token_limit=0,
      paid_monthly_token_limit=0, capability_ttl_ms=86400000 WHERE id='default'`).run();
  });
  afterEach(() => vi.restoreAllMocks());

  function createReadyModel(
    name: string,
    purpose: "vision" | "text",
    poolEnabled: boolean,
  ) {
    const model = createModelConfig({
      name,
      baseUrl: `https://${name}.example/v1`,
      apiKey: `${name}-secret`,
      model: `${name}-model`,
      purpose,
      supportsVision: purpose === "vision",
    });
    db.prepare(`UPDATE model_configs SET pool_enabled=?, billing_mode='free',
      quota_total_tokens=1000, quota_used_tokens=0, quota_expires_at=?,
      quota_safety_ratio=0.95, capability_json=?, capability_checked_at=?
      WHERE id=?`).run(
      poolEnabled ? 1 : 0,
      new Date(Date.now() + 86_400_000).toISOString(),
      JSON.stringify({ text: true, json: true, vision: purpose === "vision" }),
      Date.now(),
      model.id,
    );
    return model;
  }

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

  it("does not bypass configured pool members with a ready purpose default", () => {
    const legacy = createReadyModel("legacy-text-default", "text", false);
    setDefaultModel(legacy.id, "text");
    expect(getModelReadinessChecks().text.verified).toBe(true);

    const poolMember = createReadyModel("disabled-provider-pool", "text", true);
    db.prepare("UPDATE model_providers SET is_enabled=0 WHERE id=?").run(poolMember.providerId);

    expect(getModelReadinessChecks().text).toMatchObject({
      configured: true,
      verified: false,
    });
  });

  it("checks capability TTL, free quota, expiry, and cooldown for each purpose pool", () => {
    createReadyModel("legacy-text", "text", false);
    createReadyModel("legacy-vision", "vision", false);
    const text = createReadyModel("pool-text", "text", true);
    const vision = createReadyModel("pool-vision", "vision", true);

    expect(getModelReadinessChecks()).toMatchObject({
      text: { configured: true, verified: true },
      vision: { configured: true, verified: true },
    });

    db.prepare("UPDATE model_pool_settings SET capability_ttl_ms=60000 WHERE id='default'").run();
    db.prepare("UPDATE model_configs SET capability_checked_at=? WHERE id=?")
      .run(Date.now() - 120_000, text.id);
    expect(getModelReadinessChecks().text.verified).toBe(false);

    db.prepare(`UPDATE model_configs SET capability_checked_at=?, quota_used_tokens=950
      WHERE id=?`).run(Date.now(), text.id);
    expect(getModelReadinessChecks().text.verified).toBe(false);

    db.prepare(`UPDATE model_configs SET quota_used_tokens=0, quota_expires_at=?
      WHERE id=?`).run(new Date(Date.now() - 1_000).toISOString(), text.id);
    expect(getModelReadinessChecks().text.verified).toBe(false);

    db.prepare(`UPDATE model_configs SET quota_expires_at=?, cooldown_until=?
      WHERE id=?`).run(
      new Date(Date.now() + 86_400_000).toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
      text.id,
    );
    expect(getModelReadinessChecks().text.verified).toBe(false);
    expect(getModelReadinessChecks().vision.verified).toBe(true);

    db.prepare("UPDATE model_configs SET cooldown_until=NULL WHERE id=?").run(text.id);
    expect(getModelReadinessChecks().text.verified).toBe(true);
    expect(getModelReadinessChecks().vision.verified).toBe(true);
  });

  it("reports vision and text pool readiness independently from /api/ready", async () => {
    createReadyModel("ready-vision", "vision", true);
    const text = createReadyModel("expired-text", "text", true);
    db.prepare("UPDATE model_configs SET quota_expires_at=? WHERE id=?")
      .run(new Date(Date.now() - 1_000).toISOString(), text.id);
    vi.spyOn(fs, "statfsSync").mockReturnValue({
      bavail: config.minFreeDiskMb * 1024 * 1024 + 1,
      bsize: 1,
    } as ReturnType<typeof fs.statfsSync>);
    const server: Server = createApp().listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务器地址无效");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ready`);
      const body = await response.json() as any;

      expect(response.status).toBe(503);
      expect(body.data.models).toEqual({ vision: true, text: false });
      expect(body.data.modelChecks).toMatchObject({
        vision: { configured: true, verified: true },
        text: { configured: true, verified: false },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
  });

  it("lists the default members that still need verification or pooling for /api/ready", async () => {
    const vision = createReadyModel("pending-vision", "vision", false);
    const text = createReadyModel("pending-text", "text", false);
    setDefaultModel(vision.id, "vision");
    setDefaultModel(text.id, "text");
    db.prepare("UPDATE model_configs SET capability_checked_at=NULL, capability_json='{}' WHERE id=?").run(text.id);
    vi.spyOn(fs, "statfsSync").mockReturnValue({
      bavail: config.minFreeDiskMb * 1024 * 1024 + 1,
      bsize: 1,
    } as ReturnType<typeof fs.statfsSync>);
    const server: Server = createApp().listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务器地址无效");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ready`);
      const body = await response.json() as any;

      expect(getModelReadinessActions()).toEqual({ verifyPoolMemberIds: [vision.id, text.id] });
      expect(response.status).toBe(503);
      expect(body.data.actions).toEqual({ verifyPoolMemberIds: [vision.id, text.id] });

      db.prepare(`UPDATE model_configs SET pool_enabled=1, capability_checked_at=?, capability_json=?
        WHERE id IN (?,?)`).run(
        Date.now(),
        JSON.stringify({ text: true, json: true, vision: true }),
        vision.id,
        text.id,
      );
      expect(getModelReadinessActions()).toEqual({ verifyPoolMemberIds: [] });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
  });
});
