import { requestModel } from "../ai/model-transport";
import crypto from "node:crypto";
import { z } from "zod";
import { db } from "../db/client";
import { config } from "../config";
import { encryptSecret } from "../security/secrets";
import { buildChatCompletionsUrl, extractResponseContent } from "../ai/openai-compatible-client";
import type { ModelConfig } from "../../shared/types";
import {
  findOrCreateModelProvider,
  getCapabilityTtlMs,
  listPoolMemberStatuses,
  mapModelConfigRow,
  redactCredential,
  resolveModelMember,
  safeBaseUrlSchema,
  updateModelProvider,
} from "./model-provider-service";

const inputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  baseUrl: safeBaseUrlSchema,
  apiKey: z.string().max(4096).optional(),
  providerId: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(200),
  supportsVision: z.boolean().default(true),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().min(100).max(100000).default(1500),
  isEnabled: z.boolean().default(true),
  purpose: z.enum(["vision", "text"]).default("vision"),
});

const modelWithProviderSql = `
  SELECT m.*, p.name provider_name, p.base_url provider_base_url,
         p.api_key_ciphertext provider_api_key, p.is_enabled provider_enabled
  FROM model_configs m
  LEFT JOIN model_providers p ON p.id = m.provider_id
`;

export function listModelConfigs() {
  return (db.prepare(`${modelWithProviderSql}
    ORDER BY m.is_purpose_default DESC, m.created_at DESC`).all() as any[]).map(mapModelConfigRow);
}

export function createModelConfig(raw: unknown) {
  const input = inputSchema.parse(raw);
  let providerId = input.providerId;
  let legacyBaseUrl = input.baseUrl;
  let legacyCiphertext: string;
  if (providerId) {
    const provider = db.prepare("SELECT * FROM model_providers WHERE id=?").get(providerId) as any;
    if (!provider) throw new Error("模型供应商不存在");
    legacyBaseUrl = provider.base_url;
    legacyCiphertext = provider.api_key_ciphertext;
  } else {
    if (!input.apiKey) throw new Error("API Key is required");
    providerId = findOrCreateModelProvider(input.name, input.baseUrl, input.apiKey);
    legacyCiphertext = encryptSecret(input.apiKey, config.encryptionKey);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO model_configs
    (id,name,base_url,api_key_ciphertext,provider_id,model,purpose,is_purpose_default,supports_vision,temperature,max_tokens,is_default,is_enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)`).run(
    id, input.name, legacyBaseUrl, legacyCiphertext, providerId,
    input.model, input.purpose, input.supportsVision ? 1 : 0, input.temperature,
    input.maxTokens, 0, input.isEnabled ? 1 : 0, now, now,
  );
  return mapModelConfigRow(db.prepare(`${modelWithProviderSql} WHERE m.id=?`).get(id));
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
  const currentResolved = resolveModelMember(id);
  const patch = raw as Record<string, unknown>;
  const input = inputSchema.parse({
    name: current.name,
    baseUrl: currentResolved.baseUrl,
    model: current.model,
    purpose: current.purpose === "text" ? "text" : "vision",
    supportsVision: Boolean(current.supports_vision),
    temperature: current.temperature,
    maxTokens: current.max_tokens,
    isEnabled: Boolean(current.is_enabled),
    providerId: current.provider_id ?? undefined,
    ...patch,
  });
  let providerId = input.providerId;
  if (providerId && !db.prepare("SELECT id FROM model_providers WHERE id=?").get(providerId)) {
    throw new Error("模型供应商不存在");
  }
  const hasBaseUrl = Object.hasOwn(patch, "baseUrl");
  const hasApiKey = Object.hasOwn(patch, "apiKey");
  if (providerId && (hasBaseUrl || hasApiKey)) {
    updateModelProvider(providerId, {
      ...(hasBaseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(hasApiKey ? { apiKey: input.apiKey } : {}),
    });
  } else if (!providerId && (hasBaseUrl || hasApiKey)) {
    const apiKey = input.apiKey || currentResolved.apiKey;
    providerId = findOrCreateModelProvider(input.name, input.baseUrl, apiKey);
  }
  const now = new Date().toISOString();
  const capabilityChanged = input.model !== current.model
    || input.purpose !== current.purpose
    || Number(input.supportsVision) !== current.supports_vision
    || providerId !== (current.provider_id ?? undefined);
  db.prepare(`UPDATE model_configs SET name=?,provider_id=?,model=?,purpose=?,supports_vision=?,
    temperature=?,max_tokens=?,is_enabled=?,updated_at=?,
    capability_json=CASE WHEN ? THEN NULL ELSE capability_json END,
    capability_checked_at=CASE WHEN ? THEN NULL ELSE capability_checked_at END
    WHERE id=?`).run(
    input.name, providerId, input.model, input.purpose, input.supportsVision ? 1 : 0,
    input.temperature, input.maxTokens, input.isEnabled ? 1 : 0, now,
    capabilityChanged ? 1 : 0, capabilityChanged ? 1 : 0, id,
  );
  return mapModelConfigRow(db.prepare(`${modelWithProviderSql} WHERE m.id=?`).get(id));
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

export function getModelsForPurpose(
  purpose: "vision" | "text",
): Array<ModelConfig & { apiKey: string; baseUrl: string }> {
  const rows = db.prepare(`${modelWithProviderSql}
    WHERE m.purpose = ? AND m.is_enabled = 1
      AND (m.provider_id IS NULL OR p.is_enabled=1)
    ORDER BY m.is_purpose_default DESC, m.created_at DESC`).all(purpose) as any[];
  return rows.map((row) => resolveModelMember(row.id));
}

export function getDefaultModel() {
  return getModelForPurpose("vision");
}

export async function testModelConnection(id: string) {
  const row = resolveModelMember(id);
  const started = Date.now();
  const { response, rawText } = await requestModel(buildChatCompletionsUrl(row.baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${row.apiKey}` },
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
    const message = body?.error?.message || `连接失败 (${response.status})`;
    throw new Error(redactCredential(message, row.apiKey));
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
  const row = db.prepare(`${modelWithProviderSql}
    WHERE m.id = ? AND m.is_enabled = 1
      AND (m.provider_id IS NULL OR p.is_enabled=1)`).get(id) as any;
  if (!row) throw new Error("模型配置不存在或未启用");
  const resolved = resolveModelMember(id);
  const credentialCiphertext = row.provider_id ? row.provider_api_key : row.api_key_ciphertext;
  const credentialBaseUrl = row.provider_id ? row.provider_base_url : row.base_url;
  const result: NonNullable<ModelConfig["capabilityStatus"]> = { text: false, json: false, vision: false, errors: {} };
  const probe = async (kind: "text" | "json" | "vision", content: unknown, structured = false) => {
    try {
      const { response, rawText } = await requestModel(buildChatCompletionsUrl(resolved.baseUrl), {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolved.apiKey}` },
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
  const current = db.prepare(`${modelWithProviderSql} WHERE m.id=?`).get(id) as any;
  const currentCredential = current?.provider_id ? current.provider_api_key : current?.api_key_ciphertext;
  const currentBaseUrl = current?.provider_id ? current.provider_base_url : current?.base_url;
  if (!current
    || currentCredential !== credentialCiphertext
    || currentBaseUrl !== credentialBaseUrl
    || current.model !== row.model
    || current.purpose !== row.purpose
    || current.supports_vision !== row.supports_vision
    || current.is_enabled !== 1
    || (current.provider_id && current.provider_enabled !== 1)) {
    throw new Error("检测期间配置已变更，请重新检测");
  }
  const checkedAt = Date.now();
  const updated = db.prepare(`UPDATE model_configs SET capability_json=?, capability_checked_at=?
    WHERE id=? AND model=? AND purpose=? AND supports_vision=? AND is_enabled=1`)
    .run(JSON.stringify(result), checkedAt, id, row.model, row.purpose, row.supports_vision);
  if (!updated.changes) throw new Error("检测期间配置已变更，请重新检测");
  return { model: row.model, purpose: row.purpose, capabilities: result, checkedAt: new Date(checkedAt).toISOString() };
}

export function modelVerification(model: ModelConfig | undefined, now = Date.now()) {
  if (!model) return { configured: false, verified: false, state: "unconfigured" };
  const time = Date.parse(model.capabilityCheckedAt ?? "");
  const fresh = Number.isFinite(time) && now >= time && now - time < getCapabilityTtlMs();
  const passed = model.capabilityStatus?.text === true && model.capabilityStatus?.json === true
    && (model.purpose !== "vision" || (model.supportsVision && model.capabilityStatus.vision === true));
  return { configured: true, verified: fresh && passed, state: !Number.isFinite(time) ? "untested" : !fresh ? "expired" : passed ? "passed" : "failed", checkedAt: model.capabilityCheckedAt, modelId: model.id };
}

function poolMemberSchedulable(
  member: ReturnType<typeof listPoolMemberStatuses>[number],
  verified: boolean,
  now: number,
) {
  if (!member.isEnabled
    || !member.poolEnabled
    || !member.providerEnabled
    || !verified
    || member.memberType !== "general") return false;
  if (member.cooldownUntil && Date.parse(member.cooldownUntil) > now) return false;
  if (member.billingMode === "free") {
    if (member.quotaExpiresAt) {
      const expiresAt = Date.parse(member.quotaExpiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
    }
    const safetyLimit = (member.quotaTotalTokens ?? 0) * member.quotaSafetyRatio;
    if (member.quotaBlocked || member.quotaUsedTokens >= safetyLimit) return false;
  }
  return true;
}

function getModelReadinessForPurpose(purpose: "vision" | "text", now: number) {
  const poolMembers = listPoolMemberStatuses(purpose);
  if (!poolMembers.length) {
    return modelVerification(getModelsForPurpose(purpose)[0], now);
  }

  const checks = poolMembers.map((member) => ({
    member,
    verification: modelVerification(member, now),
  }));
  const schedulable = checks.find(({ member, verification }) =>
    poolMemberSchedulable(member, verification.verified, now)
  );
  if (schedulable) return schedulable.verification;

  const representative = checks.find(({ verification }) => !verification.verified)?.verification
    ?? checks[0].verification;
  return {
    ...representative,
    configured: true,
    verified: false,
    state: representative.verified ? "unavailable" : representative.state,
  };
}

export function getModelReadinessChecks(now = Date.now()) {
  return {
    vision: getModelReadinessForPurpose("vision", now),
    text: getModelReadinessForPurpose("text", now),
  };
}

function modelMemberActionable(
  member: ModelConfig & { apiKey: string; baseUrl: string },
  now: number,
) {
  if (member.memberType !== "general") return false;
  if (modelVerification(member, now).verified && member.poolEnabled) return false;
  if (member.quotaBlocked) return false;
  if (member.cooldownUntil && Date.parse(member.cooldownUntil) > now) return false;
  if (member.billingMode === "free" && member.quotaExpiresAt) {
    const expiresAt = Date.parse(member.quotaExpiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  }
  return true;
}

export function getModelReadinessActions(now = Date.now()) {
  const pending: string[] = [];
  for (const purpose of ["vision", "text"] as const) {
    const pooled = listPoolMemberStatuses(purpose);
    if (pooled.some((member) => poolMemberSchedulable(
      member,
      modelVerification(member, now).verified,
      now,
    ))) {
      continue;
    }
    const configured = getModelsForPurpose(purpose);
    const defaults = configured.filter((member) => member.isPurposeDefault);
    for (const member of defaults.length ? defaults : configured.slice(0, 1)) {
      if (!modelMemberActionable(member, now)) continue;
      pending.push(member.id);
    }
  }
  return { verifyPoolMemberIds: [...new Set(pending)].slice(0, 10) };
}
