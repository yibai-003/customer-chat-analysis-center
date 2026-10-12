import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, initDb } from "../db/client";
import { createModelProvider } from "./model-provider-service";
import { createModelConfig } from "./model-config-service";
import { applyBailianFreePool, previewBailianFreePool } from "./bailian-free-pool-sync-service";
import { listPoolMembers } from "./model-pool-admin-service";
import type { BailianPoolSnapshot } from "../../shared/model-pool-sync";

function reset() {
  db.exec("DELETE FROM model_usage_events; DELETE FROM model_configs; DELETE FROM model_providers;");
}

function provider() {
  return createModelProvider({
    name: "Bailian test",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "test-secret",
  });
}

function snapshot(providerId: string, names = ["qwen-text-model", "qwen-vision-model"]): BailianPoolSnapshot {
  return {
    providerId,
    capturedAt: "2026-10-10T00:00:00.000Z",
    accountMatchConfirmed: true,
    models: names.map((model, index) => ({
      model,
      name: `Display ${model}`,
      provider: "bailian",
      capabilities: [index === 0 ? "TG" : "VU"],
      modalities: { input: index === 0 ? ["Text"] : ["Image", "Text"], output: ["Text"] },
      features: ["structured-outputs"],
      offline: false,
    })),
  };
}

describe("Bailian free pool sync service", () => {
  beforeEach(() => { initDb(); reset(); });

  it("previews Qwen candidates and applies paid members idempotently while leaving them out of the pool", () => {
    const selectedProvider = provider();
    const actorId = randomUUID();
    const preview = previewBailianFreePool(snapshot(selectedProvider.id), actorId, Date.now());
    expect(preview.summary).toMatchObject({ created: 2, updated: 0, disabled: 0 });
    expect(preview.changes.map((item) => item.model)).toEqual(["qwen-text-model", "qwen-vision-model"]);

    const applied = applyBailianFreePool(preview.previewId, actorId, "APPLY BAILIAN QWEN PAID POOL", Date.now());
    expect(applied.created).toHaveLength(2);
    expect(db.prepare("SELECT pool_enabled, quota_used_tokens, billing_mode, preset_key FROM model_configs ORDER BY model")
      .all()).toEqual([
      { pool_enabled: 0, quota_used_tokens: 0, billing_mode: "paid", preset_key: "bailian-qwen-paid-pool" },
      { pool_enabled: 0, quota_used_tokens: 0, billing_mode: "paid", preset_key: "bailian-qwen-paid-pool" },
    ]);
    expect(() => applyBailianFreePool(preview.previewId, actorId, "APPLY BAILIAN QWEN PAID POOL", Date.now()))
      .toThrow(/预览/);

    const second = previewBailianFreePool(snapshot(selectedProvider.id), actorId, Date.now());
    expect(second.summary).toMatchObject({ created: 0, updated: 2, disabled: 0 });
  });

  it("adopts legacy markers in place and preserves manual removal and usage history", () => {
    const selectedProvider = provider();
    const now = new Date().toISOString();
    const id = randomUUID();
    db.prepare(`INSERT INTO model_configs
      (id,name,base_url,api_key_ciphertext,provider_id,model,purpose,is_purpose_default,
       supports_vision,temperature,max_tokens,is_default,is_enabled,created_at,updated_at,
       pool_enabled,billing_mode,quota_total_tokens,quota_used_tokens,quota_safety_ratio,
       pool_removed_at,pool_removed_reason,pool_removed_note,preset_key,preset_version)
      VALUES (?,?,?,?,?,?,?,0,0,0.2,1000,0,1,?,?,0,'free',1000000,400000,0.95,?,'maintenance','keep me','qianwen-free-pool','1')`)
      .run(id, "qwen-text-model", selectedProvider.baseUrl, "ciphertext", selectedProvider.id,
        "qwen-text-model", "text", now, now, now);
    db.prepare(`INSERT INTO model_usage_events
      (id,model_config_id,provider_id,purpose,event_type,accounted_tokens,created_at)
      VALUES ('history',?,?, 'text','success',12,?)`).run(id, selectedProvider.id, now);

    const preview = previewBailianFreePool(snapshot(selectedProvider.id, ["qwen-text-model"]), "actor", Date.now());
    applyBailianFreePool(preview.previewId, "actor", "APPLY BAILIAN QWEN PAID POOL", Date.now());
    expect(db.prepare("SELECT id,preset_key,pool_enabled,pool_removed_reason,pool_removed_note,quota_used_tokens,billing_mode FROM model_configs")
      .get()).toMatchObject({ id, preset_key: "bailian-qwen-paid-pool", pool_enabled: 0,
        pool_removed_reason: "maintenance", pool_removed_note: "keep me", quota_used_tokens: 0, billing_mode: "paid" });
    expect(db.prepare("SELECT COUNT(*) count FROM model_usage_events WHERE model_config_id=?").get(id))
      .toEqual({ count: 1 });
  });

  it("disables legacy managed non-Qwen members without deleting their history", () => {
    const selectedProvider = provider();
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO model_configs
      (id,name,base_url,api_key_ciphertext,provider_id,model,purpose,is_purpose_default,
       supports_vision,temperature,max_tokens,is_default,is_enabled,created_at,updated_at,
       pool_enabled,billing_mode,preset_key,preset_version)
      VALUES (?,?,?,?,?,?,?,0,0,0.2,1000,0,1,?,?,1,'free','bailian-free-pool',1)`)
      .run(id, "legacy", selectedProvider.baseUrl, "ciphertext", selectedProvider.id, "deepseek-old", "text", now, now);
    db.prepare(`INSERT INTO model_usage_events
      (id,model_config_id,provider_id,purpose,event_type,accounted_tokens,created_at)
      VALUES ('legacy-history',?,?, 'text','success',4,?)`).run(id, selectedProvider.id, now);

    const preview = previewBailianFreePool(snapshot(selectedProvider.id, []), "owner", Date.now());
    expect(preview.summary.disabled).toBe(1);
    applyBailianFreePool(preview.previewId, "owner", "STOP ALL MANAGED QWEN MODELS", Date.now());
    expect(db.prepare("SELECT id,model,pool_enabled,preset_key FROM model_configs WHERE id=?").get(id))
      .toMatchObject({ id, model: "deepseek-old", pool_enabled: 0, preset_key: "bailian-free-pool" });
    expect(db.prepare("SELECT COUNT(*) count FROM model_usage_events WHERE model_config_id=?").get(id))
      .toEqual({ count: 1 });
  });

  it("binds previews to the actor and rejects stale pool or provider state", () => {
    const selectedProvider = provider();
    const preview = previewBailianFreePool(snapshot(selectedProvider.id), "owner", Date.now());
    expect(() => applyBailianFreePool(preview.previewId, "other", "APPLY BAILIAN QWEN PAID POOL", Date.now()))
      .toThrow(/不存在/);
    db.prepare("UPDATE model_providers SET is_enabled=0 WHERE id=?").run(selectedProvider.id);
    expect(() => applyBailianFreePool(preview.previewId, "owner", "APPLY BAILIAN QWEN PAID POOL", Date.now()))
      .toThrow(/服务商/);
  });

  it("requires a second confirmation before disabling every managed member", () => {
    const selectedProvider = provider();
    const actorId = "owner";
    const first = previewBailianFreePool(snapshot(selectedProvider.id, ["qwen-text-model"]), actorId, Date.now());
    applyBailianFreePool(first.previewId, actorId, "APPLY BAILIAN QWEN PAID POOL", Date.now());
    const empty: BailianPoolSnapshot = { ...snapshot(selectedProvider.id, []), models: [] };
    const preview = previewBailianFreePool(empty, actorId, Date.now());
    expect(preview.requiresDisableAllConfirmation).toBe(true);
    expect(preview.summary.disabled).toBe(1);
    expect(() => applyBailianFreePool(preview.previewId, actorId, "APPLY BAILIAN QWEN PAID POOL", Date.now()))
      .toThrow(/STOP ALL MANAGED QWEN MODELS/);
    expect(applyBailianFreePool(preview.previewId, actorId, "STOP ALL MANAGED QWEN MODELS", Date.now()).disabled)
      .toHaveLength(1);
  });

  it("rolls back every write when an insert trigger fails", () => {
    const selectedProvider = provider();
    const actorId = "owner";
    const preview = previewBailianFreePool(snapshot(selectedProvider.id), actorId, Date.now());
    db.exec(`CREATE TEMP TRIGGER fail_bailian_insert BEFORE INSERT ON model_configs
      WHEN NEW.preset_key='bailian-qwen-paid-pool' BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
    expect(() => applyBailianFreePool(preview.previewId, actorId, "APPLY BAILIAN QWEN PAID POOL", Date.now()))
      .toThrow();
    expect(db.prepare("SELECT COUNT(*) count FROM model_configs").get()).toEqual({ count: 0 });
    db.exec("DROP TRIGGER fail_bailian_insert");
  });

  it("rejects duplicate historical managed rows even when they are no longer eligible", () => {
    const selectedProvider = provider();
    const first = previewBailianFreePool(snapshot(selectedProvider.id), "owner", Date.now());
    applyBailianFreePool(first.previewId, "owner", "APPLY BAILIAN QWEN PAID POOL", Date.now());
    const row = db.prepare("SELECT * FROM model_configs WHERE model='qwen-text-model'").get() as Record<string, unknown>;
    db.prepare(`INSERT INTO model_configs (id,name,base_url,api_key_ciphertext,provider_id,model,purpose,
      is_purpose_default,supports_vision,temperature,max_tokens,is_default,is_enabled,created_at,updated_at,
      pool_enabled,billing_mode,quality_tier,priority,thinking_mode,member_type,quota_total_tokens,
      quota_used_tokens,quota_expires_at,quota_safety_ratio,preset_key,preset_version)
      VALUES (?,?,?,?,?,?,?,0,?,0.2,1500,0,1,?,?,0,'free','A',99,0,'general',?,?,?,0.95,'bailian-qwen-paid-pool',1)`)
      .run(randomUUID(), row.name, row.base_url, row.api_key_ciphertext, row.provider_id, row.model, row.purpose,
        row.supports_vision, row.created_at, row.updated_at, row.quota_total_tokens, row.quota_used_tokens,
        "2099-12-31T15:59:59.999Z");
    expect(() => previewBailianFreePool({ ...snapshot(selectedProvider.id, []), models: [] }, "owner", Date.now()))
      .toThrow(/重复/);
  });

  it("rejects application when capability or failure state changes after preview", () => {
    const selectedProvider = provider();
    const first = previewBailianFreePool(snapshot(selectedProvider.id), "owner", Date.now());
    applyBailianFreePool(first.previewId, "owner", "APPLY BAILIAN QWEN PAID POOL", Date.now());
    const preview = previewBailianFreePool(snapshot(selectedProvider.id), "owner", Date.now());
    db.prepare("UPDATE model_configs SET capability_json=?, cooldown_until=?, consecutive_failures=2 WHERE provider_id=?")
      .run(JSON.stringify({ text: true, json: true, vision: false }), "2099-01-01T00:00:00.000Z", selectedProvider.id);
    expect(() => applyBailianFreePool(preview.previewId, "owner", "APPLY BAILIAN QWEN PAID POOL", Date.now()))
      .toThrow(/发生变化/);
  });

  it("rejects application when the selected provider credentials or endpoint changes", () => {
    const selectedProvider = provider();
    const preview = previewBailianFreePool(snapshot(selectedProvider.id), "owner", Date.now());
    db.prepare("UPDATE model_providers SET api_key_ciphertext=?, updated_at=? WHERE id=?")
      .run("changed-ciphertext", new Date().toISOString(), selectedProvider.id);
    expect(() => applyBailianFreePool(preview.previewId, "owner", "APPLY BAILIAN QWEN PAID POOL", Date.now()))
      .toThrow(/发生变化/);
  });

  it("rejects duplicate directory IDs", () => {
    const selectedProvider = provider();
    const duplicate = snapshot(selectedProvider.id, ["qwen-text-model"]);
    duplicate.models.push({ ...duplicate.models[0] });
    expect(() => previewBailianFreePool(duplicate, "owner", Date.now())).toThrow(/重复/);
  });

  it("disables ineligible members and records the directory exclusion reason", () => {
    const selectedProvider = provider();
    const first = previewBailianFreePool(snapshot(selectedProvider.id), "owner", Date.now());
    applyBailianFreePool(first.previewId, "owner", "APPLY BAILIAN QWEN PAID POOL", Date.now());
    const empty: BailianPoolSnapshot = { ...snapshot(selectedProvider.id, []), models: [] };
    const preview = previewBailianFreePool(empty, "owner", Date.now());
    applyBailianFreePool(preview.previewId, "owner", "STOP ALL MANAGED QWEN MODELS", Date.now());
    expect(db.prepare("SELECT pool_enabled,quota_exhausted_at,pool_removed_at,pool_removed_reason,pool_removed_note FROM model_configs ORDER BY model LIMIT 1").get())
      .toMatchObject({ pool_enabled: 0, quota_exhausted_at: null, pool_removed_at: expect.any(String), pool_removed_reason: "sync_unavailable", pool_removed_note: "bailian-sync:not_eligible" });
    expect(listPoolMembers().find((item) => item.model === "qwen-text-model"))
      .toMatchObject({ poolEnabled: false, poolRemovedAt: expect.any(String), poolRemovedReason: "sync_unavailable", poolRemovedNote: "bailian-sync:not_eligible" });
  });

  it("assigns new priorities by model order within each purpose", () => {
    const selectedProvider = provider();
    const base = snapshot(selectedProvider.id, ["qwen-z-model", "qwen-a-model"]);
    base.models[1].capabilities = ["TG"];
    base.models[1].modalities = { input: ["Text"], output: ["Text"] };
    const preview = previewBailianFreePool(base, "owner", Date.now());
    applyBailianFreePool(preview.previewId, "owner", "APPLY BAILIAN QWEN PAID POOL", Date.now());
    expect(db.prepare("SELECT model,priority FROM model_configs WHERE purpose='text' ORDER BY priority").all())
      .toEqual([{ model: "qwen-a-model", priority: 0 }, { model: "qwen-z-model", priority: 1 }]);
  });

  it("rejects the same model ID when it is used for two purposes", () => {
    const selectedProvider = provider();
    const text = memberForSnapshot(selectedProvider.id, "qwen-same-model", "Text");
    const vision = memberForSnapshot(selectedProvider.id, "qwen-same-model", "Vision");
    expect(text.model).toBe(vision.model);
    expect(() => previewBailianFreePool(snapshot(selectedProvider.id, ["qwen-same-model"]), "owner", Date.now()))
      .toThrow(/跨用途冲突/);
  });

  it("excludes an offline directory model", () => {
    const selectedProvider = provider();
    const offlineSnapshot = snapshot(selectedProvider.id, ["qwen-text-model"]);
    offlineSnapshot.models[0].offline = true;
    const preview = previewBailianFreePool(offlineSnapshot, "owner", Date.now());
    expect(preview.summary).toMatchObject({ created: 0, disabled: 0, excluded: 1 });
    expect(preview.excluded).toEqual([expect.objectContaining({ model: "qwen-text-model", reason: "offline" })]);
  });
});

function memberForSnapshot(providerId: string, model: string, purpose: "Text" | "Vision") {
  const providerRow = db.prepare("SELECT base_url FROM model_providers WHERE id=?").get(providerId) as { base_url: string };
  const member = createModelConfig({ name: model, baseUrl: providerRow.base_url, providerId,
    model, purpose: purpose === "Text" ? "text" : "vision", supportsVision: purpose === "Vision" });
  db.prepare("UPDATE model_configs SET preset_key='bailian-qwen-paid-pool', billing_mode='free' WHERE id=?").run(member.id);
  return member;
}
