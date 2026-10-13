import { z } from "zod";
import type {
  ModelConfig,
  ModelPoolSettings,
  ModelPurpose,
  ModelUsageEvent,
} from "../../shared/types";
import { db } from "../db/client";
import { testModelCapabilities } from "./model-config-service";
import { classifyModelError } from "../ai/openai-compatible-client";
import { mapModelConfigRow } from "./model-provider-service";
import { isPoolMemberVisible } from "./model-pool-policy";
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
  errorCode?: string;
}

export interface PoolVerificationOptions {
  enablePassed: boolean;
}

export function listPoolMembers(purpose?: ModelPurpose): ModelConfig[] {
  const rows = purpose
    ? db.prepare(`${modelWithProviderSql} WHERE m.purpose=? ORDER BY
        CASE WHEN m.billing_mode='paid' AND m.is_purpose_default=1 THEN 1 ELSE 0 END,
        m.priority, m.created_at, m.id`).all(purpose)
    : db.prepare(`${modelWithProviderSql} ORDER BY m.purpose,
        CASE WHEN m.billing_mode='paid' AND m.is_purpose_default=1 THEN 1 ELSE 0 END,
        m.priority, m.created_at, m.id`).all();
  return (rows as any[]).map(mapModelConfigRow);
}

export function listVisiblePoolMembers(purpose?: ModelPurpose): ModelConfig[] {
  return listPoolMembers(purpose).filter((member) => isPoolMemberVisible(member));
}

export function listPoolCandidates(purpose?: ModelPurpose): ModelConfig[] {
  return listPoolMembers(purpose).filter((member) => (
    member.billingMode === "paid"
    && member.isEnabled
    && member.providerEnabled !== false
    && member.memberType === "general"
    && !member.poolRemovedAt
    && !isPoolMemberVisible(member)
  ));
}

export function listRemovedPoolMembers(purpose?: ModelPurpose): ModelConfig[] {
  return listPoolMembers(purpose).filter((member) => (
    member.billingMode === "paid" && Boolean(member.poolRemovedAt)
  ));
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

function summarizePoolMembers(items: ModelConfig[]) {
  return {
    total: items.length,
    enabled: items.filter((item) => item.isEnabled && item.poolEnabled).length,
    verified: items.filter((item) => item.capabilityEligible).length,
    blocked: items.filter((item) => Boolean(item.cooldownUntil)).length,
  };
}

export function getPoolSummary() {
  const members = listPoolMembers();
  const visibleMembers = members.filter((member) => isPoolMemberVisible(member));
  return {
    total: visibleMembers.length,
    vision: summarizePoolMembers(visibleMembers.filter((item) => item.purpose === "vision")),
    text: summarizePoolMembers(visibleMembers.filter((item) => item.purpose === "text")),
  };
}

export const POOL_REMOVAL_REASONS = ["verify_failed", "unstable", "quota", "maintenance"] as const;
export type PoolRemovalReason = typeof POOL_REMOVAL_REASONS[number];

function validatedMemberIds(ids: string[]) {
  const parsed = z.array(z.string().min(1).max(200)).min(1).max(MAX_VERIFICATION_IDS).parse(ids);
  const unique = [...new Set(parsed)];
  if (unique.length !== parsed.length) throw new Error("成员 ID 不能重复");
  const existing = new Set((db.prepare("SELECT id FROM model_configs").all() as Array<{ id: string }>)
    .map((row) => row.id));
  if (unique.some((id) => !existing.has(id))) throw new Error("模型池成员不存在");
  return unique;
}

export function removePoolMembers(
  ids: string[],
  input: { reason: PoolRemovalReason; note?: string },
): { removed: string[] } {
  const unique = validatedMemberIds(ids);
  if (!POOL_REMOVAL_REASONS.includes(input.reason)) throw new Error("剔除原因无效");
  const now = new Date().toISOString();
  const update = db.prepare(`UPDATE model_configs SET pool_enabled=0, pool_removed_at=?,
    pool_removed_reason=?, pool_removed_note=?, updated_at=? WHERE id=?`);
  db.transaction(() => {
    for (const id of unique) update.run(now, input.reason, input.note ?? null, now, id);
  })();
  return { removed: unique };
}

export function restorePoolMembers(ids: string[]): { restored: string[] } {
  const unique = validatedMemberIds(ids);
  const now = new Date().toISOString();
  const update = db.prepare(`UPDATE model_configs SET pool_enabled=1, pool_removed_at=NULL,
    pool_removed_reason=NULL, pool_removed_note=NULL, updated_at=? WHERE id=?`);
  db.transaction(() => {
    for (const id of unique) update.run(now, id);
  })();
  return { restored: unique };
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
  const results: PoolVerificationResult[] = [];
  results.length = uniqueIds.length;
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
        if (passed && options.enablePassed
          && member.billingMode === "paid"
          && member.memberType === "general") {
          db.prepare(`UPDATE model_configs SET pool_enabled=1, pool_removed_at=NULL,
            pool_removed_reason=NULL, pool_removed_note=NULL, updated_at=? WHERE id=?`)
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
        const classified = classifyModelError(error);
        results[index] = {
          id,
          model: member.model,
          purpose: member.purpose,
          passed: false,
          error: classified.message,
          errorCode: classified.code,
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
