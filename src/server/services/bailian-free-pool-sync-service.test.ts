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

function snapshot(providerId: string, names = ["text-model", "vision-model"]): BailianPoolSnapshot {
  return {
    providerId,
    capturedAt: "2026-10-10T00:00:00.000Z",
    accountMatchConfirmed: true,
    quotas: names.map((model, index) => ({
      model,
      type: index === 0 ? "Text" : "Vision",
      remaining: 900_000,
      total: 1_000_000,
      expires: "2099-12-31",
      autoStop: true,
    })),
    models: names.map((model, index) => ({
      model,
      name: `Display ${model}`,
      provider: "bailian",
      capabilities: [index === 0 ? "TG" : "VU"],
      modalities: { input: [index === 0 ? "Text" : "Image"], output: ["Text"] },
      features: ["structured-outputs"],
      offline: false,
    })),
  };
}

describe("Bailian free pool sync service", () => {
  beforeEach(() => { initDb(); reset(); });

  it("previews candidates and applies them idempotently while keeping new models disabled", () => {
    const selectedProvider = provider();
    const actorId = randomUUID();
    const preview = previewBailianFreePool(snapshot(selectedProvider.id), actorId, Date.now());
    expect(preview.summary).toMatchObject({ created: 2, updated: 0, disabled: 0 });
    expect(preview.changes.map((item) => item.model)).toEqual(["text-model", "vision-model"]);

    const applied = applyBailianFreePool(preview.previewId, actorId, "APPLY BAILIAN FREE POOL", Date.now());
    expect(applied.created).toHaveLength(2);
    expect(db.prepare("SELECT pool_enabled, quota_used_tokens, billing_mode, preset_key FROM model_configs ORDER BY model")
      .all()).toEqual([
      { pool_enabled: 0, quota_used_tokens: 100_000, billing_mode: "free", preset_key: "bailian-free-pool" },
      { pool_enabled: 0, quota_used_tokens: 100_000, billing_mode: "free", preset_key: "bailian-free-pool" },
    ]);
    expect(() => applyBailianFreePool(preview.previewId, actorId, "APPLY BAILIAN FREE POOL", Date.now()))
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
      .run(id, "text-model", selectedProvider.baseUrl, "ciphertext", selectedProvider.id,
        "text-model", "text", now, now, now);
    db.prepare(`INSERT INTO model_usage_events
      (id,model_config_id,provider_id,purpose,event_type,accounted_tokens,created_at)
      VALUES ('history',?,?, 'text','success',12,?)`).run(id, selectedProvider.id, now);

    const preview = previewBailianFreePool(snapshot(selectedProvider.id, ["text-model"]), "actor", Date.now());
    applyBailianFreePool(preview.previewId, "actor", "APPLY BAILIAN FREE POOL", Date.now());
    expect(db.prepare("SELECT id,preset_key,pool_enabled,pool_removed_reason,pool_removed_note,quota_used_tokens FROM model_configs")
      .get()).toMatchObject({ id, preset_key: "bailian-free-pool", pool_enabled: 0,
        pool_removed_reason: "maintenance", pool_removed_note: "keep me", quota_used_tokens: 100_000 });
    expect(db.prepare("SELECT COUNT(*) count FROM model_usage_events WHERE model_config_id=?").get(id))
      .toEqual({ count: 1 });
  });

  it("binds previews to the actor and rejects stale pool or provider state", () => {
    const selectedProvider = provider();
    const preview = previewBailianFreePool(snapshot(selectedProvider.id), "owner", Date.now());
    expect(() => applyBailianFreePool(preview.previewId, "other", "APPLY BAILIAN FREE POOL", Date.now()))
      .toThrow(/不存在/);
    db.prepare("UPDATE model_providers SET is_enabled=0 WHERE id=?").run(selectedProvider.id);
    expect(() => applyBailianFreePool(preview.previewId, "owner", "APPLY BAILIAN FREE POOL", Date.now()))
      .toThrow(/服务商/);
  });

  it("requires a second confirmation before disabling every managed member", () => {
    const selectedProvider = provider();
    const actorId = "owner";
    const first = previewBailianFreePool(snapshot(selectedProvider.id, ["text-model"]), actorId, Date.now());
    applyBailianFreePool(first.previewId, actorId, "APPLY BAILIAN FREE POOL", Date.now());
    const empty: BailianPoolSnapshot = { ...snapshot(selectedProvider.id, []), quotas: [], models: [] };
    const preview = previewBailianFreePool(empty, actorId, Date.now());
    expect(preview.requiresDisableAllConfirmation).toBe(true);
    expect(preview.summary.disabled).toBe(1);
    expect(() => applyBailianFreePool(preview.previewId, actorId, "APPLY BAILIAN FREE POOL", Date.now()))
      .toThrow(/STOP ALL MANAGED FREE MODELS/);
    expect(applyBailianFreePool(preview.previewId, actorId, "STOP ALL MANAGED FREE MODELS", Date.now()).disabled)
      .toHaveLength(1);
  });

  it("rolls back every write when an insert trigger fails", () => {
    const selectedProvider = provider();
    const actorId = "owner";
    const preview = previewBailianFreePool(snapshot(selectedProvider.id), actorId, Date.now());
    db.exec(`CREATE TEMP TRIGGER fail_bailian_insert BEFORE INSERT ON model_configs
      WHEN NEW.preset_key='bailian-free-pool' BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
    expect(() => applyBailianFreePool(preview.previewId, actorId, "APPLY BAILIAN FREE POOL", Date.now()))
      .toThrow();
    expect(db.prepare("SELECT COUNT(*) count FROM model_configs").get()).toEqual({ count: 0 });
    db.exec("DROP TRIGGER fail_bailian_insert");
  });

  it("rejects duplicate historical managed rows even when they are no longer eligible", () => {
    const selectedProvider = provider();
    const first = previewBailianFreePool(snapshot(selectedProvider.id), "owner", Date.now());
    applyBailianFreePool(first.previewId, "owner", "APPLY BAILIAN FREE POOL", Date.now());
    const row = db.prepare("SELECT * FROM model_configs WHERE model='text-model'").get() as Record<string, unknown>;
    db.prepare(`INSERT INTO model_configs (id,name,base_url,api_key_ciphertext,provider_id,model,purpose,
      is_purpose_default,supports_vision,temperature,max_tokens,is_default,is_enabled,created_at,updated_at,
      pool_enabled,billing_mode,quality_tier,priority,thinking_mode,member_type,quota_total_tokens,
      quota_used_tokens,quota_expires_at,quota_safety_ratio,preset_key,preset_version)
      VALUES (?,?,?,?,?,?,?,0,?,0.2,1500,0,1,?,?,0,'free','A',99,0,'general',?,?,?,0.95,'bailian-free-pool',1)`)
      .run(randomUUID(), row.name, row.base_url, row.api_key_ciphertext, row.provider_id, row.model, row.purpose,
        row.supports_vision, row.created_at, row.updated_at, row.quota_total_tokens, row.quota_used_tokens,
        "2099-12-31T15:59:59.999Z");
    expect(() => previewBailianFreePool({ ...snapshot(selectedProvider.id, []), quotas: [], models: [] }, "owner", Date.now()))
      .toThrow(/重复/);
  });

  it("rejects application when capability or failure state changes after preview", () => {
    const selectedProvider = provider();
    const first = previewBailianFreePool(snapshot(selectedProvider.id), "owner", Date.now());
    applyBailianFreePool(first.previewId, "owner", "APPLY BAILIAN FREE POOL", Date.now());
    const preview = previewBailianFreePool(snapshot(selectedProvider.id), "owner", Date.now());
    db.prepare("UPDATE model_configs SET capability_json=?, cooldown_until=?, consecutive_failures=2 WHERE provider_id=?")
      .run(JSON.stringify({ text: true, json: true, vision: false }), "2099-01-01T00:00:00.000Z", selectedProvider.id);
    expect(() => applyBailianFreePool(preview.previewId, "owner", "APPLY BAILIAN FREE POOL", Date.now()))
      .toThrow(/发生变化/);
  });

  it("rejects application when the selected provider credentials or endpoint changes", () => {
    const selectedProvider = provider();
    const preview = previewBailianFreePool(snapshot(selectedProvider.id), "owner", Date.now());
    db.prepare("UPDATE model_providers SET api_key_ciphertext=?, updated_at=? WHERE id=?")
      .run("changed-ciphertext", new Date().toISOString(), selectedProvider.id);
    expect(() => applyBailianFreePool(preview.previewId, "owner", "APPLY BAILIAN FREE POOL", Date.now()))
      .toThrow(/发生变化/);
  });

  it("rejects duplicate quota IDs and remaining values above total", () => {
    const selectedProvider = provider();
    const duplicate = snapshot(selectedProvider.id, ["text-model"]);
    duplicate.quotas.push({ ...duplicate.quotas[0] });
    expect(() => previewBailianFreePool(duplicate, "owner", Date.now())).toThrow(/额度存在重复/);
    const invalid = snapshot(selectedProvider.id, ["text-model"]);
    invalid.quotas[0].remaining = invalid.quotas[0].total + 1;
    expect(() => previewBailianFreePool(invalid, "owner", Date.now())).toThrow(/额度范围无效/);
  });

  it("disables ineligible members without pretending the cloud quota was exhausted", () => {
    const selectedProvider = provider();
    const first = previewBailianFreePool(snapshot(selectedProvider.id), "owner", Date.now());
    applyBailianFreePool(first.previewId, "owner", "APPLY BAILIAN FREE POOL", Date.now());
    const empty: BailianPoolSnapshot = { ...snapshot(selectedProvider.id, []), quotas: [], models: [] };
    const preview = previewBailianFreePool(empty, "owner", Date.now());
    applyBailianFreePool(preview.previewId, "owner", "STOP ALL MANAGED FREE MODELS", Date.now());
    expect(db.prepare("SELECT pool_enabled,quota_exhausted_at,pool_removed_at,pool_removed_reason,pool_removed_note FROM model_configs ORDER BY model LIMIT 1").get())
      .toMatchObject({ pool_enabled: 0, quota_exhausted_at: null, pool_removed_at: expect.any(String), pool_removed_reason: "sync_unavailable", pool_removed_note: "bailian-sync:not_eligible" });
    expect(listPoolMembers().find((item) => item.model === "text-model"))
      .toMatchObject({ poolEnabled: false, poolRemovedAt: expect.any(String), poolRemovedReason: "sync_unavailable", poolRemovedNote: "bailian-sync:not_eligible" });
  });

  it("assigns new priorities by expiry and model order within each purpose", () => {
    const selectedProvider = provider();
    const base = snapshot(selectedProvider.id, ["z-model", "a-model"]);
    base.quotas[1].type = "Text";
    base.models[1].capabilities = ["TG"];
    base.models[1].modalities = { input: ["Text"], output: ["Text"] };
    base.quotas[0].expires = "2099-12-31";
    base.quotas[1].expires = "2099-01-01";
    const preview = previewBailianFreePool(base, "owner", Date.now());
    applyBailianFreePool(preview.previewId, "owner", "APPLY BAILIAN FREE POOL", Date.now());
    expect(db.prepare("SELECT model,priority FROM model_configs WHERE purpose='text' ORDER BY priority").all())
      .toEqual([{ model: "a-model", priority: 0 }, { model: "z-model", priority: 1 }]);
  });

  it("rejects the same model ID when it is used for two purposes", () => {
    const selectedProvider = provider();
    const text = memberForSnapshot(selectedProvider.id, "same-model", "Text");
    const vision = memberForSnapshot(selectedProvider.id, "same-model", "Vision");
    expect(text.model).toBe(vision.model);
    expect(() => previewBailianFreePool(snapshot(selectedProvider.id, ["same-model"]), "owner", Date.now()))
      .toThrow(/跨用途冲突/);
  });

  it("accepts an exhausted quota as a valid snapshot that disables the managed member", () => {
    const selectedProvider = provider();
    const exhausted = snapshot(selectedProvider.id, ["text-model"]);
    exhausted.quotas[0].remaining = 0;
    const preview = previewBailianFreePool(exhausted, "owner", Date.now());
    expect(preview.summary).toMatchObject({ created: 0, disabled: 0, excluded: 1 });
    expect(preview.excluded).toEqual([expect.objectContaining({ model: "text-model", reason: "invalid_quota" })]);
  });
});

function memberForSnapshot(providerId: string, model: string, purpose: "Text" | "Vision") {
  const providerRow = db.prepare("SELECT base_url FROM model_providers WHERE id=?").get(providerId) as { base_url: string };
  const member = createModelConfig({ name: model, baseUrl: providerRow.base_url, providerId,
    model, purpose: purpose === "Text" ? "text" : "vision", supportsVision: purpose === "Vision" });
  db.prepare("UPDATE model_configs SET preset_key='bailian-free-pool', billing_mode='free' WHERE id=?").run(member.id);
  return member;
}
