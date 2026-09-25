import crypto from "node:crypto";
import { z } from "zod";
import type { ModelConfig, ModelProvider, ModelPurpose } from "../../shared/types";
import { requestModel } from "../ai/model-transport";
import {
  buildChatCompletionsUrl,
  classifyModelError,
} from "../ai/openai-compatible-client";
import { config } from "../config";
import { db } from "../db/client";
import { decryptSecret, encryptSecret, maskSecret } from "../security/secrets";
import {
  isPoolMemberEligible,
  rankModelCandidates,
} from "./model-pool-policy";

export interface ResolvedPoolMember extends ModelConfig {
  apiKey: string;
  baseUrl: string;
  providerId?: string;
  providerEnabled: boolean;
}

export interface PoolMemberStatus extends ModelConfig {
  providerEnabled: boolean;
}

export const safeBaseUrlSchema = z.string().max(2048).url().refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol)
    && !url.username
    && !url.password
    && !url.search
    && !url.hash;
}, "Base URL 必须为无账号、查询参数或片段的 HTTP(S) 地址");

const providerInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  baseUrl: safeBaseUrlSchema,
  apiKey: z.string().max(4096).optional(),
  isEnabled: z.boolean().default(true),
});

function providerMask(value: string) {
  return "*".repeat(Math.max(8, Math.min(16, value.length)));
}

export function redactCredential(value: string, secret: string) {
  return secret ? value.replaceAll(secret, providerMask(secret)) : value;
}

function mapProviderRow(row: any): ModelProvider {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    maskedApiKey: providerMask(decryptSecret(row.api_key_ciphertext, config.encryptionKey)),
    isEnabled: Boolean(row.is_enabled),
    lastTestedAt: row.last_tested_at ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

export function getCapabilityTtlMs() {
  const row = db.prepare(
    "SELECT capability_ttl_ms FROM model_pool_settings WHERE id='default'",
  ).get() as { capability_ttl_ms: number } | undefined;
  if (!row) throw new Error("模型池设置不存在");
  return row.capability_ttl_ms;
}

export function mapModelConfigRow(row: any): ModelConfig {
  const ciphertext = row.provider_id && row.provider_api_key
    ? row.provider_api_key
    : row.api_key_ciphertext;
  const key = decryptSecret(ciphertext, config.encryptionKey);
  const capabilityStatus = row.capability_json ? JSON.parse(row.capability_json) : undefined;
  const capabilityCheckedAt = row.capability_checked_at
    ? new Date(row.capability_checked_at).toISOString()
    : undefined;
  const capabilityTime = Date.parse(capabilityCheckedAt ?? "");
  const now = Date.now();
  const capabilityFresh = Number.isFinite(capabilityTime)
    && now >= capabilityTime
    && now - capabilityTime < getCapabilityTtlMs();
  const capabilityPassed = capabilityStatus?.text === true
    && capabilityStatus?.json === true
    && (row.purpose !== "vision" || (Boolean(row.supports_vision) && capabilityStatus.vision === true));
  const quotaUsedTokens = row.quota_used_tokens ?? 0;
  const quotaSafetyRatio = row.quota_safety_ratio ?? 0.95;
  const quotaBlocked = Boolean(row.quota_exhausted_at)
    || (row.quota_total_tokens != null && quotaUsedTokens >= row.quota_total_tokens * quotaSafetyRatio);
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.provider_id && row.provider_base_url ? row.provider_base_url : row.base_url,
    maskedApiKey: maskSecret(key),
    model: row.model,
    supportsVision: Boolean(row.supports_vision),
    temperature: row.temperature,
    maxTokens: row.max_tokens,
    isDefault: Boolean(row.is_default),
    purpose: row.purpose === "text" ? "text" : "vision",
    isPurposeDefault: Boolean(row.is_purpose_default ?? row.is_default),
    isEnabled: Boolean(row.is_enabled),
    capabilityStatus,
    capabilityCheckedAt,
    providerId: row.provider_id ?? undefined,
    providerName: row.provider_name ?? undefined,
    poolEnabled: Boolean(row.pool_enabled),
    billingMode: row.billing_mode === "free" ? "free" : "paid",
    qualityTier: row.quality_tier === "B" || row.quality_tier === "C" ? row.quality_tier : "A",
    priority: row.priority ?? 100,
    thinkingMode: Boolean(row.thinking_mode),
    memberType: row.member_type === "ocr" ? "ocr" : "general",
    quotaTotalTokens: row.quota_total_tokens ?? undefined,
    quotaUsedTokens,
    quotaExpiresAt: row.quota_expires_at ?? undefined,
    quotaSafetyRatio,
    quotaExhaustedAt: row.quota_exhausted_at ?? undefined,
    cooldownUntil: row.cooldown_until ?? undefined,
    consecutiveFailures: row.consecutive_failures ?? 0,
    lastSuccessAt: row.last_success_at ?? undefined,
    lastFailureAt: row.last_failure_at ?? undefined,
    presetKey: row.preset_key ?? undefined,
    presetVersion: row.preset_version ?? undefined,
    capabilityEligible: capabilityFresh && capabilityPassed,
    quotaBlocked,
    poolRemovedAt: row.pool_removed_at ?? undefined,
    poolRemovedReason: row.pool_removed_reason ?? undefined,
    poolRemovedNote: row.pool_removed_note ?? undefined,
  };
}

const modelWithProviderSql = `
  SELECT m.*, p.name provider_name, p.base_url provider_base_url,
         p.api_key_ciphertext provider_api_key, p.is_enabled provider_enabled
  FROM model_configs m
  LEFT JOIN model_providers p ON p.id = m.provider_id
`;

export function listModelProviders() {
  return (db.prepare("SELECT * FROM model_providers ORDER BY created_at DESC").all() as any[])
    .map(mapProviderRow);
}

export function createModelProvider(raw: unknown) {
  const input = providerInputSchema.parse(raw);
  if (!input.apiKey) throw new Error("API Key is required");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO model_providers
    (id,name,base_url,api_key_ciphertext,is_enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(
    id,
    input.name,
    input.baseUrl,
    encryptSecret(input.apiKey, config.encryptionKey),
    input.isEnabled ? 1 : 0,
    now,
    now,
  );
  return mapProviderRow(db.prepare("SELECT * FROM model_providers WHERE id=?").get(id));
}

export function updateModelProvider(id: string, raw: unknown) {
  const current = db.prepare("SELECT * FROM model_providers WHERE id=?").get(id) as any;
  if (!current) throw new Error("模型供应商不存在");
  const patch = raw as Record<string, unknown>;
  const input = providerInputSchema.parse({
    name: current.name,
    baseUrl: current.base_url,
    isEnabled: Boolean(current.is_enabled),
    ...patch,
  });
  const ciphertext = Object.hasOwn(patch, "apiKey")
    ? encryptSecret(input.apiKey || decryptSecret(current.api_key_ciphertext, config.encryptionKey), config.encryptionKey)
    : current.api_key_ciphertext;
  const endpointChanged = input.baseUrl !== current.base_url;
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE model_providers
      SET name=?,base_url=?,api_key_ciphertext=?,is_enabled=?,updated_at=?
      WHERE id=?`).run(
      input.name,
      input.baseUrl,
      ciphertext,
      input.isEnabled ? 1 : 0,
      now,
      id,
    );
    if (endpointChanged) {
      db.prepare(`UPDATE model_configs
        SET capability_json=NULL,capability_checked_at=NULL,updated_at=?
        WHERE provider_id=?`).run(now, id);
    }
  })();
  return mapProviderRow(db.prepare("SELECT * FROM model_providers WHERE id=?").get(id));
}

export function deleteModelProvider(id: string) {
  const current = db.prepare("SELECT id FROM model_providers WHERE id=?").get(id);
  if (!current) throw new Error("模型供应商不存在");
  const reference = db.prepare("SELECT COUNT(*) count FROM model_configs WHERE provider_id=?")
    .get(id) as { count: number };
  if (reference.count > 0) throw new Error("模型供应商仍被模型配置引用");
  db.prepare("DELETE FROM model_providers WHERE id=?").run(id);
}

export function disableModelProvider(id: string, reason: string) {
  const current = db.prepare("SELECT api_key_ciphertext FROM model_providers WHERE id=?").get(id) as any;
  if (!current) throw new Error("模型供应商不存在");
  const apiKey = decryptSecret(current.api_key_ciphertext, config.encryptionKey);
  const result = db.prepare(`UPDATE model_providers
    SET is_enabled=0,last_error=?,updated_at=? WHERE id=?`).run(
    redactCredential(reason, apiKey).slice(0, 1000),
    new Date().toISOString(),
    id,
  );
  if (!result.changes) throw new Error("模型供应商不存在");
  return mapProviderRow(db.prepare("SELECT * FROM model_providers WHERE id=?").get(id));
}

export function resolveModelMember(id: string): ResolvedPoolMember {
  const row = db.prepare(`${modelWithProviderSql} WHERE m.id = ?`).get(id) as any;
  if (!row) throw new Error("模型配置不存在");
  const usesProvider = Boolean(row.provider_id);
  if (usesProvider && !row.provider_api_key) throw new Error("模型供应商不存在");
  return {
    ...mapModelConfigRow(row),
    apiKey: decryptSecret(
      usesProvider ? row.provider_api_key : row.api_key_ciphertext,
      config.encryptionKey,
    ),
    baseUrl: usesProvider ? row.provider_base_url : row.base_url,
    providerEnabled: usesProvider ? Boolean(row.provider_enabled) : true,
  };
}

export function listPoolMemberStatuses(purpose: ModelPurpose): PoolMemberStatus[] {
  const rows = db.prepare(`${modelWithProviderSql}
    WHERE m.purpose=? AND m.pool_enabled=1
    ORDER BY m.is_purpose_default DESC, m.priority ASC, m.created_at DESC`).all(purpose) as any[];
  return rows.map((row) => ({
    ...mapModelConfigRow(row),
    providerEnabled: row.provider_id ? Boolean(row.provider_enabled) : true,
  }));
}

export function resolvePoolMembers(purpose: ModelPurpose): ResolvedPoolMember[] {
  const rows = db.prepare(`${modelWithProviderSql}
    WHERE m.purpose=? AND m.pool_enabled=1 AND m.is_enabled=1
      AND (m.provider_id IS NULL OR p.is_enabled=1)
    ORDER BY m.is_purpose_default DESC, m.priority ASC, m.created_at DESC`).all(purpose) as any[];
  return rows.map((row) => ({
    ...mapModelConfigRow(row),
    apiKey: decryptSecret(
      row.provider_id ? row.provider_api_key : row.api_key_ciphertext,
      config.encryptionKey,
    ),
    baseUrl: row.provider_id ? row.provider_base_url : row.base_url,
    providerEnabled: row.provider_id ? Boolean(row.provider_enabled) : true,
  }));
}

export function findOrCreateModelProvider(name: string, baseUrl: string, apiKey: string) {
  const candidates = db.prepare("SELECT * FROM model_providers WHERE base_url=?").all(baseUrl) as any[];
  const existing = candidates.find((row) =>
    decryptSecret(row.api_key_ciphertext, config.encryptionKey) === apiKey
  );
  if (existing) return existing.id as string;
  return createModelProvider({ name, baseUrl, apiKey, isEnabled: true }).id;
}

export async function testModelProvider(id: string) {
  const provider = db.prepare("SELECT * FROM model_providers WHERE id=?").get(id) as any;
  if (!provider) throw new Error("模型供应商不存在");
  const rows = db.prepare(`${modelWithProviderSql}
    WHERE m.provider_id=? AND m.is_enabled=1`).all(id) as any[];
  if (!rows.length) throw new Error("请先为供应商配置并启用模型");
  const candidates = rows.map((row) => ({
    ...mapModelConfigRow(row),
    apiKey: decryptSecret(row.provider_api_key, config.encryptionKey),
    baseUrl: row.provider_base_url,
    providerEnabled: Boolean(row.provider_enabled),
  }));
  const now = Date.now();
  const eligible = rankModelCandidates(candidates.filter((member) =>
    isPoolMemberEligible(member, {
      now,
      allowPaid: true,
      failedMemberIds: new Set(),
    })
  ));
  const eligibleIds = new Set(eligible.map((member) => member.id));
  const fallback = rankModelCandidates(candidates.filter((member) =>
    !eligibleIds.has(member.id)
    && member.memberType === "general"
    && !member.quotaBlocked
    && (!member.cooldownUntil || Date.parse(member.cooldownUntil) <= now)
  ));
  const ordered = [...eligible, ...fallback];
  const started = Date.now();
  const testedAt = new Date().toISOString();
  let lastError = "没有可用于连接测试的模型";

  for (const member of ordered) {
    try {
      const { response, rawText } = await requestModel(buildChatCompletionsUrl(member.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${member.apiKey}`,
        },
        body: JSON.stringify({
          model: member.model,
          temperature: 0,
          max_tokens: 32,
          messages: [{ role: "user", content: "只返回 OK" }],
        }),
      }, { attempts: 1, timeoutMs: 30000 });
      if (!response.ok) {
        let message = `连接失败 (${response.status})`;
        try {
          const body = JSON.parse(rawText);
          if (typeof body?.error?.message === "string") message = body.error.message.slice(0, 1000);
        } catch {
          // Provider returned a non-JSON error.
        }
        const withStatus = /\(\d{3}\)/.test(message) ? message : `${message} (${response.status})`;
        const classified = classifyModelError(new Error(withStatus));
        const redacted = redactCredential(classified.message, member.apiKey).slice(0, 1000);
        lastError = redacted;
        const timestamp = new Date().toISOString();
        if (classified.code === "quota_exhausted") {
          db.prepare(`UPDATE model_configs SET quota_exhausted_at=?,last_failure_at=?,updated_at=?
            WHERE id=?`).run(timestamp, timestamp, timestamp, member.id);
          continue;
        }
        if (classified.code === "rate_limit" || classified.code === "model") {
          db.prepare("UPDATE model_configs SET last_failure_at=?,updated_at=? WHERE id=?")
            .run(timestamp, timestamp, member.id);
          continue;
        }
        db.prepare("UPDATE model_providers SET last_tested_at=?,last_error=?,updated_at=? WHERE id=?")
          .run(testedAt, redacted, testedAt, id);
        throw new Error(redacted);
      }
      db.prepare("UPDATE model_providers SET last_tested_at=?,last_error=NULL,updated_at=? WHERE id=?")
        .run(testedAt, testedAt, id);
      return {
        success: true,
        latencyMs: Date.now() - started,
        modelConfigId: member.id,
        model: member.model,
        purpose: member.purpose,
      };
    } catch (error) {
      const message = redactCredential(
        error instanceof Error ? error.message : String(error),
        member.apiKey,
      ).slice(0, 1000);
      const saved = db.prepare("SELECT last_tested_at FROM model_providers WHERE id=?").get(id) as any;
      if (saved?.last_tested_at !== testedAt) {
        db.prepare("UPDATE model_providers SET last_tested_at=?,last_error=?,updated_at=? WHERE id=?")
          .run(testedAt, message || "连接请求失败", testedAt, id);
      }
      throw new Error(message || "连接请求失败", { cause: error });
    }
  }

  db.prepare("UPDATE model_providers SET last_tested_at=?,last_error=?,updated_at=? WHERE id=?")
    .run(testedAt, lastError, testedAt, id);
  throw new Error(lastError);
}
