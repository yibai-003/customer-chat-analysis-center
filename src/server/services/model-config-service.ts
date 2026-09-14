import { requestModel } from "../ai/model-transport";
import crypto from "node:crypto";
import { z } from "zod";
import { db } from "../db/client";
import { config } from "../config";
import { decryptSecret, encryptSecret, maskSecret } from "../security/secrets";
import { buildChatCompletionsUrl, extractResponseContent } from "../ai/openai-compatible-client";
import type { ModelConfig } from "../../shared/types";

const inputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().max(2048).url().refine(value => { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }, "Base URL 必须为无账号、查询参数或片段的 HTTP(S) 地址"),
  apiKey: z.string().max(4096).optional(),
  model: z.string().trim().min(1).max(200),
  supportsVision: z.boolean().default(true),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().min(100).max(100000).default(1500),
  isEnabled: z.boolean().default(true),
  purpose: z.enum(["vision", "text"]).default("vision"),
});

function mapRow(row: any): ModelConfig {
  const key = decryptSecret(row.api_key_ciphertext, config.encryptionKey);
  return {
    id: row.id, name: row.name, baseUrl: row.base_url, maskedApiKey: maskSecret(key),
    model: row.model, supportsVision: Boolean(row.supports_vision), temperature: row.temperature,
    maxTokens: row.max_tokens, isDefault: Boolean(row.is_default),
    purpose: row.purpose === "text" ? "text" : "vision",
    isPurposeDefault: Boolean(row.is_purpose_default ?? row.is_default),
    isEnabled: Boolean(row.is_enabled),
    capabilityStatus: row.capability_json ? JSON.parse(row.capability_json) : undefined,
    capabilityCheckedAt: row.capability_checked_at ? new Date(row.capability_checked_at).toISOString() : undefined,
  };
}

export function listModelConfigs() {
  return (db.prepare("SELECT * FROM model_configs ORDER BY is_purpose_default DESC, created_at DESC").all() as any[]).map(mapRow);
}

export function createModelConfig(raw: unknown) {
  const input = inputSchema.parse(raw);
  if (!input.apiKey) throw new Error("API Key is required");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO model_configs
    (id,name,base_url,api_key_ciphertext,model,purpose,is_purpose_default,supports_vision,temperature,max_tokens,is_default,is_enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?,?)`).run(id, input.name, input.baseUrl, encryptSecret(input.apiKey, config.encryptionKey),
    input.model, input.purpose, input.supportsVision ? 1 : 0, input.temperature, input.maxTokens, 0, input.isEnabled ? 1 : 0, now, now);
  return mapRow(db.prepare("SELECT * FROM model_configs WHERE id = ?").get(id));
}

export function setDefaultModel(id: string, purpose?: "vision" | "text") {
  const exists = db.prepare("SELECT id FROM model_configs WHERE id = ? AND is_enabled = 1").get(id);
  if (!exists) throw new Error("模型配置不存在或未启用");
  const transaction = db.transaction(() => {
    const row = db.prepare("SELECT purpose FROM model_configs WHERE id = ?").get(id) as any;
    const targetPurpose = purpose ?? row.purpose ?? "vision";
    db.prepare("UPDATE model_configs SET is_purpose_default = 0, is_default = CASE WHEN ? = 'vision' THEN 0 ELSE is_default END WHERE purpose = ?").run(targetPurpose, targetPurpose);
    db.prepare("UPDATE model_configs SET is_purpose_default = 1, is_default = CASE WHEN ? = 'vision' THEN 1 ELSE is_default END, updated_at = ? WHERE id = ?").run(targetPurpose, new Date().toISOString(), id);
  });
  transaction();
}

export function updateModelConfig(id: string, raw: unknown) {
  const current = db.prepare("SELECT * FROM model_configs WHERE id = ?").get(id) as any;
  if (!current) throw new Error("模型配置不存在");
  const input = inputSchema.parse({
    name: current.name,
    baseUrl: current.base_url,
    model: current.model,
    purpose: current.purpose === "text" ? "text" : "vision",
    supportsVision: Boolean(current.supports_vision),
    temperature: current.temperature,
    maxTokens: current.max_tokens,
    isEnabled: Boolean(current.is_enabled),
    ...(raw as Record<string, unknown>),
  });
  const apiKey = input.apiKey || decryptSecret(current.api_key_ciphertext, config.encryptionKey);
  const now = new Date().toISOString();
  db.prepare(`UPDATE model_configs SET name=?,base_url=?,api_key_ciphertext=?,model=?,purpose=?,supports_vision=?,
    temperature=?,max_tokens=?,is_enabled=?,updated_at=?,capability_json=NULL,capability_checked_at=NULL WHERE id=?`).run(
    input.name, input.baseUrl, encryptSecret(apiKey, config.encryptionKey), input.model,
    input.purpose, input.supportsVision ? 1 : 0, input.temperature, input.maxTokens, input.isEnabled ? 1 : 0, now, id,
  );
  return mapRow(db.prepare("SELECT * FROM model_configs WHERE id = ?").get(id));
}

export function deleteModelConfig(id: string) {
  const current = db.prepare("SELECT is_default, is_purpose_default, purpose FROM model_configs WHERE id = ?").get(id) as any;
  if (!current) throw new Error("模型配置不存在");
  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM model_configs WHERE id = ?").run(id);
    if (current.is_purpose_default) {
      const replacement = db.prepare("SELECT id FROM model_configs WHERE purpose = ? AND is_enabled = 1 ORDER BY created_at DESC LIMIT 1").get(current.purpose) as any;
      if (replacement) setDefaultModel(replacement.id, current.purpose);
    }
  });
  transaction();
}

export function getModelForPurpose(purpose: "vision" | "text") {
  const models = getModelsForPurpose(purpose);
  if (!models.length) throw new Error("请先配置并启用默认模型");
  return models[0];
}

export function getModelsForPurpose(purpose: "vision" | "text") {
  const rows = db.prepare(`SELECT * FROM model_configs
    WHERE purpose = ? AND is_enabled = 1
    ORDER BY is_purpose_default DESC, created_at DESC`).all(purpose) as any[];
  return rows.map((row) => ({
    ...mapRow(row),
    apiKey: decryptSecret(row.api_key_ciphertext, config.encryptionKey),
    baseUrl: row.base_url,
  }));
}

export function getDefaultModel() {
  return getModelForPurpose("vision");
}

export async function testModelConnection(id: string) {
  const row = db.prepare("SELECT * FROM model_configs WHERE id = ?").get(id) as any;
  if (!row) throw new Error("模型配置不存在");
  const started = Date.now();
  const { response, rawText } = await requestModel(buildChatCompletionsUrl(row.base_url), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${decryptSecret(row.api_key_ciphertext, config.encryptionKey)}` },
    body: JSON.stringify({
      model: row.model,
      temperature: 0,
      max_tokens: 32,
      messages: [{ role: "user", content: "只返回 OK" }],
    }),
  });
  if (!response.ok) {
    let body: any = {};
    try { body = JSON.parse(rawText); } catch { /* non-JSON provider error */ }
    throw new Error(body?.error?.message || `连接失败 (${response.status})`);
  }
  return { success: true, latencyMs: Date.now() - started };
}

const runningChecks = new Map<string, Promise<Awaited<ReturnType<typeof runCapabilityCheck>>>>();
export function testModelCapabilities(id: string) {
  const active = runningChecks.get(id);
  if (active) return active;
  const check = runCapabilityCheck(id).finally(() => runningChecks.delete(id));
  runningChecks.set(id, check);
  return check;
}

const redTestImage = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC";
async function runCapabilityCheck(id: string) {
  const row = db.prepare("SELECT * FROM model_configs WHERE id = ? AND is_enabled = 1").get(id) as any;
  if (!row) throw new Error("模型配置不存在或未启用");
  const result: NonNullable<ModelConfig["capabilityStatus"]> = { text: false, json: false, vision: false, errors: {} };
  const probe = async (kind: "text" | "json" | "vision", content: unknown, structured = false) => {
    try {
      const { response, rawText } = await requestModel(buildChatCompletionsUrl(row.base_url), {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${decryptSecret(row.api_key_ciphertext, config.encryptionKey)}` },
        body: JSON.stringify({ model: row.model, temperature: 0, max_tokens: 100,
          messages: [{ role: "user", content }], ...(structured ? { response_format: { type: "json_object" } } : {}) }),
      }, { attempts: 1, timeoutMs: 30000 });
      if (!response.ok) { result.errors![kind] = `HTTP_${response.status}`; return; }
      const answer = extractResponseContent(JSON.parse(rawText)).trim();
      if (kind === "json") {
        const obj = JSON.parse(answer);
        result.json = obj !== null && !Array.isArray(obj) && typeof obj === "object" && obj.ok === true;
      } else if (kind === "vision") result.vision = /^(red|红色|红)[.!。！]?$/i.test(answer);
      else result.text = /^OK[.!]?$/i.test(answer);
      if (!result[kind]) result.errors![kind] = "INVALID_OUTPUT";
    } catch (error) {
      result.errors![kind] = error instanceof SyntaxError ? "INVALID_JSON" : "REQUEST_FAILED";
    }
  };
  await probe("text", "Reply with exactly OK.");
  await probe("json", 'Return valid json with exactly {"ok":true}.', true);
  if (row.supports_vision || row.purpose === "vision") {
    await probe("vision", [{ type: "text", text: "What is the dominant color in this image? Reply with one color word only." }, { type: "image_url", image_url: { url: `data:image/png;base64,${redTestImage}` } }]);
  }
  const checkedAt = Date.now();
  const updated = db.prepare(`UPDATE model_configs SET capability_json=?, capability_checked_at=?
    WHERE id=? AND api_key_ciphertext=? AND base_url=? AND model=? AND purpose=? AND supports_vision=? AND is_enabled=1`)
    .run(JSON.stringify(result), checkedAt, id, row.api_key_ciphertext, row.base_url, row.model, row.purpose, row.supports_vision);
  if (!updated.changes) throw new Error("检测期间配置已变更，请重新检测");
  return { model: row.model, purpose: row.purpose, capabilities: result, checkedAt: new Date(checkedAt).toISOString() };
}

export function modelVerification(model: ModelConfig | undefined, now = Date.now()) {
  if (!model) return { configured: false, verified: false, state: "unconfigured" };
  const time = Date.parse(model.capabilityCheckedAt ?? "");
  const fresh = Number.isFinite(time) && now >= time && now - time < 86400000;
  const passed = model.capabilityStatus?.text === true && model.capabilityStatus?.json === true
    && (model.purpose !== "vision" || (model.supportsVision && model.capabilityStatus.vision === true));
  return { configured: true, verified: fresh && passed, state: !Number.isFinite(time) ? "untested" : !fresh ? "expired" : passed ? "passed" : "failed", checkedAt: model.capabilityCheckedAt, modelId: model.id };
}
