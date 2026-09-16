import crypto from "node:crypto";
import { z } from "zod";
import type {
  ModelConfig,
  ModelPoolSettings,
  ModelPurpose,
  ModelUsageEvent,
} from "../../shared/types";
import { db } from "../db/client";
import { testModelCapabilities } from "./model-config-service";
import { mapModelConfigRow } from "./model-provider-service";
import {
  QIANWEN_FREE_POOL_PRESET,
  QIANWEN_FREE_POOL_PRESET_VERSION,
} from "./qianwen-free-pool-preset";

const QIANWEN_FREE_POOL_PRESET_KEY = "qianwen-free-pool";
const MAX_VERIFICATION_IDS = 50;
const VERIFICATION_CONCURRENCY = 2;

const modelWithProviderSql = `
  SELECT m.*, p.name provider_name, p.base_url provider_base_url,
         p.api_key_ciphertext provider_api_key, p.is_enabled provider_enabled
  FROM model_configs m
  LEFT JOIN model_providers p ON p.id = m.provider_id
`;

export interface PoolVerificationResult {
  id: string;
  model?: string;
  purpose?: ModelPurpose;
  passed: boolean;
  capabilities?: NonNullable<ModelConfig["capabilityStatus"]>;
  checkedAt?: string;
  error?: string;
}

export interface PoolVerificationOptions {
  enablePassed: boolean;
}

function enabledDashScopeProvider() {
  const providers = db.prepare("SELECT * FROM model_providers WHERE is_enabled=1 ORDER BY created_at, id")
    .all() as any[];
  return providers.find((provider) => {
    try {
      return new URL(provider.base_url).hostname.toLowerCase() === "dashscope.aliyuncs.com";
    } catch {
      return false;
    }
  });
}

export function installQianwenFreePool(): {
  created: string[];
  updated: string[];
  needsVerification: string[];
} {
  const provider = enabledDashScopeProvider();
  if (!provider) throw new Error("请先配置并启用千问服务商凭证");
  const result = { created: [] as string[], updated: [] as string[], needsVerification: [] as string[] };
  const now = new Date().toISOString();

  db.transaction(() => {
    const findExisting = db.prepare(`SELECT * FROM model_configs
      WHERE provider_id=? AND purpose=? AND model=? ORDER BY created_at, id LIMIT 1`);
    const createMember = db.prepare(`INSERT INTO model_configs (
      id,name,base_url,api_key_ciphertext,provider_id,model,purpose,is_purpose_default,
      supports_vision,temperature,max_tokens,is_default,is_enabled,created_at,updated_at,
      pool_enabled,billing_mode,quality_tier,priority,thinking_mode,member_type,
      quota_total_tokens,quota_used_tokens,quota_expires_at,quota_safety_ratio,
      capability_json,capability_checked_at,preset_key,preset_version
    ) VALUES (?,?,?,?,?,?,?,0,?,0.2,1500,0,1,?,?,0,'free',?,?,?,?,?,?,?,0.95,NULL,NULL,?,?)`);
    const adoptMember = db.prepare(`UPDATE model_configs SET
      billing_mode='free', quality_tier=?, priority=?, thinking_mode=?, member_type=?,
      quota_total_tokens=?, quota_used_tokens=CASE
        WHEN preset_key IS NULL AND quota_used_tokens=0 THEN ? ELSE quota_used_tokens END,
      quota_expires_at=?, quota_safety_ratio=0.95, preset_key=?, preset_version=?, updated_at=?
      WHERE id=?`);
    const updateMember = db.prepare(`UPDATE model_configs SET
      quality_tier=?, priority=?, thinking_mode=?, member_type=?, quota_total_tokens=?,
      quota_expires_at=?, quota_safety_ratio=0.95, preset_version=?, updated_at=?
      WHERE id=?`);

    for (const preset of QIANWEN_FREE_POOL_PRESET) {
      const existing = findExisting.get(provider.id, preset.purpose, preset.model) as any;
      if (!existing) {
        const id = crypto.randomUUID();
        createMember.run(
          id,
          preset.model,
          provider.base_url,
          provider.api_key_ciphertext,
          provider.id,
          preset.model,
          preset.purpose,
          preset.purpose === "vision" ? 1 : 0,
          now,
          now,
          preset.qualityTier,
          preset.priority,
          preset.thinkingMode ? 1 : 0,
          preset.memberType,
          preset.quotaTotalTokens,
          preset.initialUsedTokens ?? 0,
          preset.quotaExpiresAt,
          QIANWEN_FREE_POOL_PRESET_KEY,
          QIANWEN_FREE_POOL_PRESET_VERSION,
        );
        result.created.push(id);
        result.needsVerification.push(id);
        continue;
      }

      if (existing.preset_key == null) {
        adoptMember.run(
          preset.qualityTier,
          preset.priority,
          preset.thinkingMode ? 1 : 0,
          preset.memberType,
          preset.quotaTotalTokens,
          preset.initialUsedTokens ?? 0,
          preset.quotaExpiresAt,
          QIANWEN_FREE_POOL_PRESET_KEY,
          QIANWEN_FREE_POOL_PRESET_VERSION,
          now,
          existing.id,
        );
      } else {
        updateMember.run(
          preset.qualityTier,
          preset.priority,
          preset.thinkingMode ? 1 : 0,
          preset.memberType,
          preset.quotaTotalTokens,
          preset.quotaExpiresAt,
          QIANWEN_FREE_POOL_PRESET_VERSION,
          now,
          existing.id,
        );
      }
      result.updated.push(existing.id);
      if (!existing.capability_json || !existing.capability_checked_at) {
        result.needsVerification.push(existing.id);
      }
    }
  })();

  return result;
}

export function listPoolMembers(purpose?: ModelPurpose): ModelConfig[] {
  const rows = purpose
    ? db.prepare(`${modelWithProviderSql} WHERE m.purpose=? ORDER BY m.priority, m.created_at, m.id`).all(purpose)
    : db.prepare(`${modelWithProviderSql} ORDER BY m.purpose, m.priority, m.created_at, m.id`).all();
  return (rows as any[]).map(mapModelConfigRow);
}

const poolMemberPatchSchema = z.object({
  isEnabled: z.boolean().optional(),
  poolEnabled: z.boolean().optional(),
  billingMode: z.enum(["free", "paid"]).optional(),
  qualityTier: z.enum(["A", "B", "C"]).optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  quotaTotalTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  quotaUsedTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  quotaExpiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  quotaSafetyRatio: z.number().positive().max(1).optional(),
});

export function updatePoolMember(id: string, raw: unknown) {
  if (!db.prepare("SELECT id FROM model_configs WHERE id=?").get(id)) {
    throw new Error("模型池成员不存在");
  }
  const patch = poolMemberPatchSchema.parse(raw);
  const columns: Record<keyof typeof patch, string> = {
    isEnabled: "is_enabled",
    poolEnabled: "pool_enabled",
    billingMode: "billing_mode",
    qualityTier: "quality_tier",
    priority: "priority",
    quotaTotalTokens: "quota_total_tokens",
    quotaUsedTokens: "quota_used_tokens",
    quotaExpiresAt: "quota_expires_at",
    quotaSafetyRatio: "quota_safety_ratio",
  };
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch) as Array<[keyof typeof patch, unknown]>) {
    assignments.push(`${columns[key]}=?`);
    values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
  }
  if (assignments.length) {
    assignments.push("updated_at=?");
    values.push(new Date().toISOString(), id);
    db.prepare(`UPDATE model_configs SET ${assignments.join(",")} WHERE id=?`).run(...values);
  }
  return mapModelConfigRow(db.prepare(`${modelWithProviderSql} WHERE m.id=?`).get(id));
}

export function getPoolSummary() {
  const members = listPoolMembers();
  const summarize = (items: ModelConfig[]) => ({
    total: items.length,
    enabled: items.filter((item) => item.isEnabled && item.poolEnabled).length,
    verified: items.filter((item) => item.capabilityEligible).length,
    blocked: items.filter((item) => item.quotaBlocked || Boolean(item.cooldownUntil)).length,
  });
  return {
    total: members.length,
    vision: summarize(members.filter((item) => item.purpose === "vision")),
    text: summarize(members.filter((item) => item.purpose === "text")),
  };
}

const settingsSchema = z.object({
  paidDailyTokenLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  paidMonthlyTokenLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  capabilityTtlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

export function getModelPoolSettings(): ModelPoolSettings {
  const row = db.prepare("SELECT * FROM model_pool_settings WHERE id='default'").get() as any;
  if (!row) throw new Error("模型池设置不存在");
  return {
    paidDailyTokenLimit: row.paid_daily_token_limit,
    paidMonthlyTokenLimit: row.paid_monthly_token_limit,
    capabilityTtlMs: row.capability_ttl_ms,
  };
}

export function updateModelPoolSettings(raw: unknown): ModelPoolSettings {
  const current = getModelPoolSettings();
  const patch = settingsSchema.parse(raw);
  const next = { ...current, ...patch };
  db.prepare(`UPDATE model_pool_settings SET
    paid_daily_token_limit=?, paid_monthly_token_limit=?, capability_ttl_ms=?, updated_at=?
    WHERE id='default'`).run(
    next.paidDailyTokenLimit,
    next.paidMonthlyTokenLimit,
    next.capabilityTtlMs,
    new Date().toISOString(),
  );
  return getModelPoolSettings();
}

const usageFilterSchema = z.object({
  purpose: z.enum(["vision", "text"]).optional(),
  eventType: z.enum([
    "success",
    "failure",
    "switch",
    "quota_exhausted",
    "cooldown",
    "paid_blocked",
    "usage_unknown",
  ]).optional(),
  modelConfigId: z.string().min(1).max(200).optional(),
  cursor: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

function mapUsageEvent(row: any): ModelUsageEvent {
  return {
    id: row.id,
    modelConfigId: row.model_config_id,
    providerId: row.provider_id ?? undefined,
    purpose: row.purpose,
    eventType: row.event_type,
    inputTokens: row.input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    accountedTokens: row.accounted_tokens,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    recordId: row.record_id ?? undefined,
    fieldId: row.field_id ?? undefined,
    operation: row.operation ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    createdAt: row.created_at,
  };
}

export function listModelUsageEvents(raw: unknown = {}): ModelUsageEvent[] {
  const filter = usageFilterSchema.parse(raw);
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filter.purpose) {
    clauses.push("purpose=?");
    values.push(filter.purpose);
  }
  if (filter.eventType) {
    clauses.push("event_type=?");
    values.push(filter.eventType);
  }
  if (filter.modelConfigId) {
    clauses.push("model_config_id=?");
    values.push(filter.modelConfigId);
  }
  if (filter.cursor) {
    clauses.push("created_at<?");
    values.push(filter.cursor);
  }
  values.push(filter.limit);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return (db.prepare(`SELECT * FROM model_usage_events ${where}
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(...values) as any[]).map(mapUsageEvent);
}

export async function verifyPoolMembers(
  ids: string[],
  options: PoolVerificationOptions = { enablePassed: false },
): Promise<PoolVerificationResult[]> {
  const uniqueIds = [...new Set(z.array(z.string().min(1).max(200)).parse(ids))];
  if (uniqueIds.length > MAX_VERIFICATION_IDS) {
    throw new Error("每次最多验证 50 个模型池成员");
  }
  const results = new Array<PoolVerificationResult>(uniqueIds.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < uniqueIds.length) {
      const index = nextIndex++;
      const id = uniqueIds[index];
      const member = listPoolMembers().find((item) => item.id === id);
      if (!member) {
        results[index] = { id, passed: false, error: "模型池成员不存在" };
        continue;
      }
      try {
        const checked = await testModelCapabilities(id);
        const capabilities = checked.capabilities;
        const passed = capabilities.text && capabilities.json
          && (member.purpose === "text" || capabilities.vision);
        if (!passed || member.memberType === "ocr") {
          db.prepare("UPDATE model_configs SET pool_enabled=0, updated_at=? WHERE id=?")
            .run(new Date().toISOString(), id);
        } else if (options.enablePassed) {
          db.prepare("UPDATE model_configs SET pool_enabled=1, updated_at=? WHERE id=?")
            .run(new Date().toISOString(), id);
        }
        results[index] = {
          id,
          model: checked.model,
          purpose: checked.purpose,
          passed,
          capabilities,
          checkedAt: checked.checkedAt,
        };
      } catch (error) {
        db.prepare("UPDATE model_configs SET pool_enabled=0, updated_at=? WHERE id=?")
          .run(new Date().toISOString(), id);
        results[index] = {
          id,
          model: member.model,
          purpose: member.purpose,
          passed: false,
          error: error instanceof Error ? error.message : "能力验证失败",
        };
      }
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(VERIFICATION_CONCURRENCY, uniqueIds.length) },
    () => worker(),
  ));
  return results;
}
