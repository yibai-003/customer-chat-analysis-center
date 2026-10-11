import crypto from "node:crypto";
import { z } from "zod";
import type { BailianPoolSnapshot, BailianPoolCandidate, BailianExcludedModel } from "../../shared/model-pool-sync";
import { selectBailianPoolCandidates } from "./model-pool-sync-policy";
import { db } from "../db/client";

const PRESET_KEY = "bailian-free-pool";
const LEGACY_PRESET_KEY = "qianwen-free-pool";
const PRESET_VERSION = 1;
const PREVIEW_TTL_MS = 5 * 60_000;
const MAX_PREVIEWS = 20;
const CONFIRM = "APPLY BAILIAN FREE POOL";
const STOP_CONFIRM = "STOP ALL MANAGED FREE MODELS";

function modelPurposeKey(model: string, purpose: "text" | "vision") {
  return `${model}\0${purpose}`;
}

const snapshotSchema = z.object({
  providerId: z.string().min(1).max(200),
  capturedAt: z.string().datetime({ offset: true }),
  accountMatchConfirmed: z.literal(true),
  quotas: z.array(z.object({
    model: z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/),
    type: z.string().max(40),
    remaining: z.number().int().safe().nonnegative(),
    total: z.number().int().safe().positive(),
    expires: z.string().min(1).max(80),
    autoStop: z.boolean(),
  }).strict()).max(500),
  models: z.array(z.object({
    model: z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/),
    name: z.string().min(1).max(300),
    provider: z.string().min(1).max(120),
    capabilities: z.array(z.string().max(80)).max(100),
    modalities: z.object({ input: z.array(z.string().max(80)).max(30), output: z.array(z.string().max(80)).max(30) }).strict(),
    features: z.array(z.string().max(80)).max(100),
    offline: z.boolean(),
    upcomingOfflineAt: z.string().max(80).nullable().optional(),
  }).strict()).max(500),
}).strict();

interface DbRow {
  id: string;
  model: string;
  purpose: "text" | "vision";
  base_url: string;
  api_key_ciphertext: string;
  name: string;
  created_at: string;
  updated_at: string;
  is_enabled: number;
  pool_removed_at?: string | null;
  priority?: number | null;
  [key: string]: unknown;
}
type ChangeType = "create" | "update" | "disable";
export interface BailianPoolChange {
  type: ChangeType;
  id?: string;
  model: string;
  purpose: "text" | "vision";
  reason?: string;
  candidate?: BailianPoolCandidate;
}
export interface BailianPoolSummary {
  created: number;
  updated: number;
  disabled: number;
  preservedManual: number;
  excluded: number;
}
export interface BailianPoolPreview {
  previewId: string;
  expiresAt: string;
  changes: BailianPoolChange[];
  excluded: BailianExcludedModel[];
  summary: BailianPoolSummary;
  requiresDisableAllConfirmation: boolean;
}
export interface BailianPoolApplyResult {
  created: string[];
  updated: string[];
  disabled: string[];
  preservedManual: string[];
  summary: BailianPoolSummary;
}

interface StoredPreview {
  preview: BailianPoolPreview;
  snapshot: BailianPoolSnapshot;
  actorId: string;
  fingerprint: string;
}
const previews = new Map<string, StoredPreview>();

function cleanPreviews(now: number) {
  for (const [id, item] of previews) {
    if (Date.parse(item.preview.expiresAt) <= now) previews.delete(id);
  }
  while (previews.size >= MAX_PREVIEWS) {
    const oldest = previews.keys().next().value;
    if (!oldest) break;
    previews.delete(oldest);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).toSorted().join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function poolFingerprint(providerId: string): string {
  const provider = db.prepare(`SELECT id,base_url,api_key_ciphertext,is_enabled,updated_at
    FROM model_providers WHERE id=?`).get(providerId);
  const rows = db.prepare(`SELECT id,model,purpose,pool_enabled,billing_mode,priority,quota_total_tokens,
      quota_used_tokens,quota_expires_at,quota_exhausted_at,is_enabled,is_purpose_default,
      capability_json,capability_checked_at,cooldown_until,consecutive_failures,last_success_at,
      last_failure_at,pool_removed_at,pool_removed_reason,pool_removed_note,preset_key,preset_version
      FROM model_configs WHERE provider_id=? AND is_purpose_default=0 ORDER BY id`).all(providerId);
  return crypto.createHash("sha256").update(canonical({ provider, rows })).digest("hex");
}

function providerFor(id: string): DbRow {
  const row = db.prepare("SELECT * FROM model_providers WHERE id=?").get(id) as DbRow | undefined;
  if (!row || !row.is_enabled) throw new Error("百炼服务商不存在或未启用");
  try {
    const url = new URL(row.base_url);
    if (!["https:", "http:"].includes(url.protocol)
      || url.username || url.password
      || url.hostname.toLowerCase() !== "dashscope.aliyuncs.com") throw new Error();
  } catch {
    throw new Error("百炼服务商地址无效");
  }
  return row;
}

function managedRows(providerId: string): DbRow[] {
  return db.prepare(`SELECT * FROM model_configs WHERE provider_id=? AND billing_mode='free'
    AND is_purpose_default=0 AND preset_key IN (?,?) ORDER BY created_at,id`).all(
    providerId, PRESET_KEY, LEGACY_PRESET_KEY,
  ) as DbRow[];
}

function assertNoManagedDuplicates(providerId: string) {
  const duplicate = db.prepare(`SELECT model,purpose,COUNT(*) count FROM model_configs
    WHERE provider_id=? AND billing_mode='free' AND is_purpose_default=0 AND preset_key IN (?,?)
    GROUP BY model,purpose HAVING COUNT(*) > 1 LIMIT 1`).get(providerId, PRESET_KEY, LEGACY_PRESET_KEY) as Pick<DbRow, "model"> | undefined;
  if (duplicate) throw new Error(`托管模型存在重复记录: ${duplicate.model}`);
  const crossPurpose = db.prepare(`SELECT model,COUNT(DISTINCT purpose) count FROM model_configs
    WHERE provider_id=? AND is_purpose_default=0 AND preset_key IN (?,?)
    GROUP BY model HAVING COUNT(DISTINCT purpose) > 1 LIMIT 1`).get(providerId, PRESET_KEY, LEGACY_PRESET_KEY) as { model: string } | undefined;
  if (crossPurpose) throw new Error(`托管模型跨用途冲突: ${crossPurpose.model}`);
}

function assertNoManualCollisions(providerId: string, changes: BailianPoolChange[]) {
  for (const change of changes) {
    if (change.type === "disable") continue;
    const manual = db.prepare(`SELECT id FROM model_configs WHERE provider_id=? AND model=? AND purpose=?
      AND (preset_key IS NULL OR preset_key NOT IN (?,?))`).get(
      providerId, change.model, change.purpose, PRESET_KEY, LEGACY_PRESET_KEY,
    ) as { id: string } | undefined;
    if (manual) throw new Error(`模型已由手工配置占用: ${change.model}`);
  }
}

function buildPlan(snapshot: BailianPoolSnapshot, now: number) {
  const quotaIds = new Set<string>();
  for (const quota of snapshot.quotas) {
    if (quotaIds.has(quota.model)) throw new Error(`百炼额度存在重复模型: ${quota.model}`);
    quotaIds.add(quota.model);
    if (quota.remaining > quota.total) throw new Error(`百炼额度范围无效: ${quota.model}`);
  }
  const catalogIds = new Set<string>();
  for (const model of snapshot.models) {
    if (catalogIds.has(model.model)) throw new Error(`百炼目录存在重复模型: ${model.model}`);
    catalogIds.add(model.model);
  }
  const selected = selectBailianPoolCandidates(snapshot, now);
  const invalidSnapshotReasons = new Set([
    "missing_catalog", "duplicate_catalog", "duplicate_quota", "invalid_expiry",
    "missing_capabilities", "missing_structured_outputs",
  ]);
  const invalid = selected.excluded.find((item) => invalidSnapshotReasons.has(item.reason));
  if (invalid) throw new Error(`百炼快照不完整或无效: ${invalid.model}`);
  const candidates = selected.candidates.toSorted((left, right) =>
    left.quotaExpiresAt.localeCompare(right.quotaExpiresAt) || left.model.localeCompare(right.model));
  const excluded = selected.excluded;
  const rows = managedRows(snapshot.providerId);
  const byKey = new Map<string, DbRow[]>();
  for (const row of rows) {
    const key = modelPurposeKey(row.model, row.purpose);
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  let changes: BailianPoolChange[] = [];
  const matched = new Set<string>();
  const preservedManual: string[] = [];
  for (const candidate of candidates) {
    const key = modelPurposeKey(candidate.model, candidate.purpose);
    const existing = byKey.get(key) ?? [];
    if (existing.length > 1) throw new Error(`托管模型存在重复记录: ${candidate.model}`);
    const manual = db.prepare(`SELECT id FROM model_configs WHERE provider_id=? AND model=? AND purpose=?
      AND (preset_key IS NULL OR preset_key NOT IN (?,?))`).all(
      snapshot.providerId, candidate.model, candidate.purpose, PRESET_KEY, LEGACY_PRESET_KEY,
    ) as Array<{ id: string }>;
    if (manual.length) throw new Error(`模型已由手工配置占用: ${candidate.model}`);
    const otherPurpose = db.prepare(`SELECT id FROM model_configs WHERE provider_id=? AND model=?
      AND purpose<>? AND is_purpose_default=0`).get(snapshot.providerId, candidate.model, candidate.purpose) as { id: string } | undefined;
    if (otherPurpose) throw new Error(`模型跨用途冲突: ${candidate.model}`);
    const row = existing[0];
    if (row) {
      matched.add(row.id);
      changes.push({ type: "update", id: row.id, model: candidate.model, purpose: candidate.purpose, candidate });
    } else {
      changes.push({ type: "create", model: candidate.model, purpose: candidate.purpose, candidate });
    }
  }
  for (const row of rows) {
    if (matched.has(row.id)) continue;
    const exclusion = excluded.find((item) => item.model === row.model);
    changes.push({ type: "disable", id: row.id, model: row.model, purpose: row.purpose,
      reason: exclusion?.reason ?? "not_eligible" });
  }
  for (const row of rows) {
    if (row.pool_removed_at && row.pool_removed_reason !== "sync_unavailable" && matched.has(row.id)) preservedManual.push(row.id);
  }
  const summary: BailianPoolSummary = {
    created: changes.filter((item) => item.type === "create").length,
    updated: changes.filter((item) => item.type === "update").length,
    disabled: changes.filter((item) => item.type === "disable").length,
    preservedManual: preservedManual.length,
    excluded: excluded.length,
  };
  return { changes, excluded, summary, preservedManual };
}

export function previewBailianFreePool(raw: BailianPoolSnapshot, actorId: string, now = Date.now()): BailianPoolPreview {
  const snapshot = snapshotSchema.parse(raw) as BailianPoolSnapshot;
  if (!actorId) throw new Error("操作者不存在");
  providerFor(snapshot.providerId);
  assertNoManagedDuplicates(snapshot.providerId);
  cleanPreviews(now);
  const plan = buildPlan(snapshot, now);
  const preview: BailianPoolPreview = {
    previewId: crypto.randomUUID(),
    expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
    changes: plan.changes,
    excluded: plan.excluded,
    summary: plan.summary,
    requiresDisableAllConfirmation: plan.summary.created === 0 && plan.summary.updated === 0 && plan.summary.disabled > 0,
  };
  previews.set(preview.previewId, { preview, snapshot, actorId, fingerprint: poolFingerprint(snapshot.providerId) });
  return preview;
}

function assertPreview(item: StoredPreview, actorId: string, confirmation: string, now: number) {
  if (item.actorId !== actorId) throw new Error("预览不存在或不属于当前操作者");
  if (Date.parse(item.preview.expiresAt) <= now) throw new Error("预览已过期");
  if (item.preview.requiresDisableAllConfirmation) {
    if (confirmation !== STOP_CONFIRM) throw new Error(`必须输入 ${STOP_CONFIRM}`);
  } else if (confirmation !== CONFIRM) {
    throw new Error(`确认口令无效，应输入 ${CONFIRM}`);
  }
  providerFor(item.snapshot.providerId);
  if (poolFingerprint(item.snapshot.providerId) !== item.fingerprint) throw new Error("模型池在预览后已发生变化，请重新预览");
}

export function applyBailianFreePool(previewId: string, actorId: string, confirmation: string, now = Date.now()): BailianPoolApplyResult {
  const item = previews.get(previewId);
  if (!item) throw new Error("预览不存在或已消费");
  assertPreview(item, actorId, confirmation, now);
  const created: string[] = [];
  const updated: string[] = [];
  const disabled: string[] = [];
  const preservedManual: string[] = [];
  const timestamp = new Date(now).toISOString();
  db.transaction(() => {
      const provider = providerFor(item.snapshot.providerId);
      assertNoManagedDuplicates(item.snapshot.providerId);
      assertNoManualCollisions(item.snapshot.providerId, item.preview.changes);
      const existingRows = managedRows(item.snapshot.providerId);
      const purposes: Array<"text" | "vision"> = ["text", "vision"];
      const nextPriorityByPurpose = new Map<"text" | "vision", number>(purposes.map((purpose): ["text" | "vision", number] => [
        purpose,
        existingRows.filter((row) => row.purpose === purpose)
          .reduce((max, row) => Math.max(max, Number(row.priority ?? 0)), -1) + 1,
      ]));
      const existingModelsByPurpose = new Map<string, Set<string>>();
      for (const row of existingRows) {
        const models = existingModelsByPurpose.get(row.purpose) ?? new Set<string>();
        models.add(row.model);
        existingModelsByPurpose.set(row.purpose, models);
      }
      const orderedCreates = item.preview.changes.filter((change) => change.type === "create")
        .toSorted((left, right) => (left.candidate?.quotaExpiresAt ?? "").localeCompare(right.candidate?.quotaExpiresAt ?? "")
          || left.model.localeCompare(right.model));
      const insert = db.prepare(`INSERT INTO model_configs
        (id,name,base_url,api_key_ciphertext,provider_id,model,purpose,is_purpose_default,supports_vision,
         temperature,max_tokens,is_default,is_enabled,created_at,updated_at,pool_enabled,billing_mode,
         quality_tier,priority,thinking_mode,member_type,quota_total_tokens,quota_used_tokens,
         quota_expires_at,quota_safety_ratio,preset_key,preset_version)
        VALUES (?,?,?,?,?,?,?,0,?,0.2,1500,0,1,?,?,0,'free',?,?,?,?,?,?,?,0.95,?,?)`);
      const update = db.prepare(`UPDATE model_configs SET name=?,base_url=?,provider_id=?,supports_vision=?,billing_mode='free',
        quality_tier='A',thinking_mode=0,member_type='general',quota_total_tokens=?,quota_used_tokens=?,
        quota_expires_at=?,quota_safety_ratio=0.95,quota_exhausted_at=NULL,preset_key=?,preset_version=?,updated_at=? WHERE id=?`);
      const disable = db.prepare("UPDATE model_configs SET pool_enabled=0, pool_removed_at=CASE WHEN pool_removed_at IS NULL THEN ? ELSE pool_removed_at END, pool_removed_reason=CASE WHEN pool_removed_at IS NULL THEN 'sync_unavailable' ELSE pool_removed_reason END, pool_removed_note=CASE WHEN pool_removed_at IS NULL THEN ? ELSE pool_removed_note END, updated_at=? WHERE id=?");
      for (const change of [...item.preview.changes.filter((candidate) => candidate.type !== "create"), ...orderedCreates]) {
        if (change.type === "create") {
          const candidate = change.candidate!;
          const id = crypto.randomUUID();
          insert.run(id, candidate.name, provider.base_url, provider.api_key_ciphertext, provider.id,
            candidate.model, candidate.purpose, candidate.supportsVision ? 1 : 0, timestamp, timestamp,
            candidate.qualityTier, nextPriorityByPurpose.get(candidate.purpose)!, candidate.thinkingMode ? 1 : 0, candidate.memberType,
            candidate.quotaTotalTokens, candidate.quotaUsedTokens, candidate.quotaExpiresAt, PRESET_KEY, PRESET_VERSION);
          nextPriorityByPurpose.set(candidate.purpose, nextPriorityByPurpose.get(candidate.purpose)! + 1);
          created.push(id);
        } else if (change.type === "update") {
          const candidate = change.candidate!;
          update.run(candidate.name, provider.base_url, provider.id, candidate.supportsVision ? 1 : 0,
            candidate.quotaTotalTokens, candidate.quotaUsedTokens, candidate.quotaExpiresAt,
            PRESET_KEY, PRESET_VERSION, timestamp, change.id);
          if (change.id && existingRows.find((row) => row.id === change.id)?.pool_removed_at
            && existingRows.find((row) => row.id === change.id)?.pool_removed_reason !== "sync_unavailable") preservedManual.push(change.id);
          else updated.push(change.id!);
        } else {
          disable.run(timestamp, `bailian-sync:${change.reason ?? "not_eligible"}`, timestamp, change.id);
          disabled.push(change.id!);
        }
      }
  })();
  previews.delete(previewId);
  const summary: BailianPoolSummary = { created: created.length, updated: updated.length, disabled: disabled.length,
    preservedManual: preservedManual.length, excluded: item.preview.summary.excluded };
  return { created, updated, disabled, preservedManual, summary };
}

export const BAILIAN_POOL_CONFIRMATION = CONFIRM;
export const BAILIAN_POOL_STOP_CONFIRMATION = STOP_CONFIRM;
