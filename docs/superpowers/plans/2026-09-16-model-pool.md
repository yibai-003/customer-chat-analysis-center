# Free Model Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified free-first model pool that reuses the current Qianwen credential, consumes expiring free quotas in order, fails over safely, records usage, and blocks paid calls unless an explicit Token budget exists.

**Architecture:** Separate provider credentials from model members while retaining `model_configs` as the compatibility surface. A single model router owns candidate selection, retry/failover, cooldowns, quota accounting, paid-budget enforcement, and usage events; field analysis and knowledge services call that router instead of iterating models. The model configuration dialog becomes an operational console with provider, pool, and call-status views.

**Tech Stack:** TypeScript 7, Node.js 22, Express 5, SQLite via better-sqlite3, React 19, Zod 4, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-09-16-model-pool-design.md`

## Global Constraints

- Keep existing `model_configs` API and legacy Base URL/API-key columns readable during migration.
- Never return or log a complete API Key.
- Reuse the currently configured Qianwen/DashScope credential; do not scrape the benefits page or modify account-side switches.
- Free models stop scheduling at `quota_total_tokens * quota_safety_ratio`, with a default safety ratio of `0.95`.
- Candidate order is free before paid, expiry ascending, remaining quota ascending, quality A/B/C, non-thinking before thinking, manual priority, then recent health.
- Thinking members are eligible only when all non-thinking free members for the purpose are unavailable or have failed in the current route.
- Paid batch, daily, and monthly Token budgets default to `0`.
- One successful response ends routing immediately; the same screenshot may be sent to another vision model only after an explicit failed attempt with no usable result.
- Capability checks must pass and remain fresh for a member to accept production work.
- Preserve all unrelated dirty-worktree changes and do not reset existing user work.
- Use migration version `14`; the current schema version before this feature is `13`.
- Do not introduce a new runtime dependency.

---

## File Map

**Database and shared contracts**

- Create `src/server/db/migrations/014-model-pools.ts`: provider, member metadata, usage event, and budget-setting schema plus legacy Qianwen credential migration.
- Modify `src/server/db/migrations/index.ts`: register migration 14.
- Modify `src/server/db/migrations/migrations.test.ts`: migration, backup, key-preservation, and idempotency coverage.
- Modify `src/shared/types.ts`: provider, enriched member, pool status, usage event, routing attempt, and paid-budget contracts.

**Provider and preset management**

- Create `src/server/services/model-provider-service.ts`: provider CRUD, credential resolution, connection test, and auth disable.
- Create `src/server/services/qianwen-free-pool-preset.ts`: versioned, immutable preset data.
- Create `src/server/services/model-pool-admin-service.ts`: preset installation, member editing, pool summaries, capability verification, settings, and event queries.
- Modify `src/server/services/model-config-service.ts`: compatibility adapter using provider credentials when present.

**Routing and accounting**

- Modify `src/server/ai/model-budget.ts`: add paid Token limits and atomic paid-token reservation/settlement.
- Modify `src/server/ai/openai-compatible-client.ts`: structured HTTP/quota error classification and normalized usage.
- Create `src/server/services/model-pool-service.ts`: eligibility, ordering, retry/failover, cooldowns, quota accounting, and event persistence.

**Business integration**

- Modify `src/server/services/field-analysis-service.ts`: replace three model loops with `callModelPool`.
- Modify `src/server/services/knowledge/knowledge-match-service.ts`: use the text pool.
- Modify `src/server/services/knowledge/hot-topic-service.ts`: route every `ask` call through the text pool and preserve aggregate snapshots.
- Modify the corresponding service tests to assert one-success termination and controlled failover.

**HTTP and UI**

- Create `src/server/routes/model-pool-router.ts`: provider, pool, verification, settings, and usage endpoints.
- Modify `src/server/app.ts`: mount the router while retaining legacy model routes.
- Create `src/client/components/model-config/ProviderView.tsx`.
- Create `src/client/components/model-config/PoolView.tsx`.
- Create `src/client/components/model-config/UsageView.tsx`.
- Modify `src/client/components/ModelConfigDialog.tsx`: tab shell and data orchestration.
- Modify `src/client/components/AnalysisRunDialog.tsx`: explicit per-batch paid-token budget, default `0`.
- Modify `src/client/hooks/useModelReadiness.ts`: readiness from eligible pool members rather than purpose defaults.
- Modify `src/client/styles.css`: dense operational tables, statuses, responsive layout.
- Add/update React tests for install, editing, status, errors, readiness, and paid-budget submission.

---

### Task 1: Persist Providers, Pool Metadata, Usage Events, and Budgets

**Files:**
- Create: `src/server/db/migrations/014-model-pools.ts`
- Modify: `src/server/db/migrations/index.ts`
- Modify: `src/server/db/migrations/migrations.test.ts`
- Modify: `src/shared/types.ts`

**Interfaces:**
- Produces: `ModelProvider`, enriched `ModelConfig`, `ModelUsageEvent`, `ModelPoolSettings`, `ModelRouteAttempt`, and `ModelRouteResult`.
- Produces database tables `model_providers`, `model_usage_events`, `model_pool_settings` and new columns on `model_configs`.
- Consumes existing encrypted `model_configs.api_key_ciphertext` without decrypting or rewriting the legacy value.

- [ ] **Step 1: Write migration tests that express the compatibility contract**

Add tests that create one DashScope vision row, one DashScope text row, and one unrelated provider row, run migration 14, and assert:

```ts
expect(currentSchemaVersion).toBe(14);
expect(qwenRows.every((row) => row.provider_id === qwenRows[0].provider_id)).toBe(true);
expect(qwenRows.every((row) => row.api_key_ciphertext === originalCiphertextById[row.id])).toBe(true);
expect(db.prepare("SELECT COUNT(*) count FROM model_pool_settings").get()).toEqual({ count: 1 });
expect(db.prepare("SELECT paid_daily_token_limit FROM model_pool_settings WHERE id='default'").get())
  .toEqual({ paid_daily_token_limit: 0 });
```

Also run the migration twice and assert no duplicate provider or settings rows.

- [ ] **Step 2: Run the migration tests and verify the expected failure**

Run:

```powershell
npx vitest run src/server/db/migrations/migrations.test.ts --pool=threads --maxWorkers=1
```

Expected: FAIL because migration 14 and the new tables/columns do not exist.

- [ ] **Step 3: Implement migration 14**

Create these tables and columns:

```sql
CREATE TABLE model_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  last_tested_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE model_configs ADD COLUMN provider_id TEXT REFERENCES model_providers(id);
ALTER TABLE model_configs ADD COLUMN pool_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_configs ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'paid'
  CHECK (billing_mode IN ('free','paid'));
ALTER TABLE model_configs ADD COLUMN quality_tier TEXT NOT NULL DEFAULT 'A'
  CHECK (quality_tier IN ('A','B','C'));
ALTER TABLE model_configs ADD COLUMN priority INTEGER NOT NULL DEFAULT 100;
ALTER TABLE model_configs ADD COLUMN thinking_mode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_configs ADD COLUMN member_type TEXT NOT NULL DEFAULT 'general'
  CHECK (member_type IN ('general','ocr'));
ALTER TABLE model_configs ADD COLUMN quota_total_tokens INTEGER;
ALTER TABLE model_configs ADD COLUMN quota_used_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_configs ADD COLUMN quota_expires_at TEXT;
ALTER TABLE model_configs ADD COLUMN quota_safety_ratio REAL NOT NULL DEFAULT 0.95;
ALTER TABLE model_configs ADD COLUMN quota_exhausted_at TEXT;
ALTER TABLE model_configs ADD COLUMN cooldown_until TEXT;
ALTER TABLE model_configs ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_configs ADD COLUMN last_success_at TEXT;
ALTER TABLE model_configs ADD COLUMN last_failure_at TEXT;
ALTER TABLE model_configs ADD COLUMN preset_key TEXT;
ALTER TABLE model_configs ADD COLUMN preset_version INTEGER;

CREATE TABLE model_usage_events (
  id TEXT PRIMARY KEY,
  model_config_id TEXT NOT NULL REFERENCES model_configs(id) ON DELETE CASCADE,
  provider_id TEXT REFERENCES model_providers(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('vision','text')),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('success','failure','switch','quota_exhausted','cooldown','paid_blocked','usage_unknown')
  ),
  input_tokens INTEGER,
  output_tokens INTEGER,
  accounted_tokens INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  record_id TEXT,
  field_id TEXT,
  operation TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_model_usage_events_created_at ON model_usage_events(created_at DESC);
CREATE INDEX idx_model_usage_events_model ON model_usage_events(model_config_id, created_at DESC);
CREATE INDEX idx_model_configs_pool ON model_configs(purpose, pool_enabled, is_enabled);

CREATE TABLE model_pool_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  paid_daily_token_limit INTEGER NOT NULL DEFAULT 0,
  paid_monthly_token_limit INTEGER NOT NULL DEFAULT 0,
  capability_ttl_ms INTEGER NOT NULL DEFAULT 86400000,
  updated_at TEXT NOT NULL
);
```

For DashScope rows, select the enabled purpose-default row first, create one `千问百炼` provider from its Base URL and ciphertext, and assign every row whose host is `dashscope.aliyuncs.com` to that provider. For other rows, deduplicate only exact `(base_url, api_key_ciphertext)` pairs. Keep legacy credentials untouched.

- [ ] **Step 4: Add exact shared types**

Add:

```ts
export type ModelPurpose = "vision" | "text";
export type ModelBillingMode = "free" | "paid";
export type ModelQualityTier = "A" | "B" | "C";

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  maskedApiKey: string;
  isEnabled: boolean;
  lastTestedAt?: string;
  lastError?: string;
}

export interface ModelPoolSettings {
  paidDailyTokenLimit: number;
  paidMonthlyTokenLimit: number;
  capabilityTtlMs: number;
}

export interface ModelUsageEvent {
  id: string;
  modelConfigId: string;
  providerId?: string;
  purpose: ModelPurpose;
  eventType: "success" | "failure" | "switch" | "quota_exhausted"
    | "cooldown" | "paid_blocked" | "usage_unknown";
  inputTokens?: number;
  outputTokens?: number;
  accountedTokens: number;
  errorCode?: string;
  errorMessage?: string;
  recordId?: string;
  fieldId?: string;
  operation?: string;
  durationMs?: number;
  createdAt: string;
}

export interface ModelRouteAttempt {
  modelConfigId: string;
  model: string;
  status: "success" | "failed" | "switched" | "blocked";
  errorCode?: string;
  durationMs: number;
}

export interface ModelRouteResult {
  content: string;
  raw: string;
  usage: { prompt_tokens?: number; completion_tokens?: number };
  model: ModelConfig;
  attempts: ModelRouteAttempt[];
}
```

Extend `ModelConfig` with:

```ts
providerId?: string;
providerName?: string;
poolEnabled: boolean;
billingMode: ModelBillingMode;
qualityTier: ModelQualityTier;
priority: number;
thinkingMode: boolean;
memberType: "general" | "ocr";
quotaTotalTokens?: number;
quotaUsedTokens: number;
quotaExpiresAt?: string;
quotaSafetyRatio: number;
quotaExhaustedAt?: string;
cooldownUntil?: string;
consecutiveFailures: number;
lastSuccessAt?: string;
lastFailureAt?: string;
presetKey?: string;
presetVersion?: number;
capabilityEligible: boolean;
quotaBlocked: boolean;
```

Add `maxPaidTokens?: number` to `AnalysisJobOptions`.

- [ ] **Step 5: Run migration and type tests**

Run:

```powershell
npx vitest run src/server/db/migrations/migrations.test.ts --pool=threads --maxWorkers=1
npm run typecheck
```

Expected: migration tests PASS; typecheck may expose consumers that require temporary optional fields, which must be corrected before committing.

- [ ] **Step 6: Commit the persistence contract**

```powershell
git add src/server/db/migrations/014-model-pools.ts src/server/db/migrations/index.ts src/server/db/migrations/migrations.test.ts src/shared/types.ts
git commit -m "feat: add model pool persistence"
```

---

### Task 2: Separate Provider Credentials from Legacy Model Members

**Files:**
- Create: `src/server/services/model-provider-service.ts`
- Create: `src/server/services/model-provider-service.test.ts`
- Modify: `src/server/services/model-config-service.ts`
- Modify: `src/server/services/model-config-service.test.ts`

**Interfaces:**
- Produces: `listModelProviders()`, `createModelProvider(raw)`, `updateModelProvider(id, raw)`, `testModelProvider(id)`, `disableModelProvider(id, reason)`.
- Produces: `resolveModelMember(id)` and `resolvePoolMembers(purpose)` returning a member plus decrypted provider credentials.
- Preserves: `listModelConfigs()`, `getModelsForPurpose()`, and legacy model CRUD.

Define the server-only resolved type in `model-provider-service.ts`:

```ts
export interface ResolvedPoolMember extends ModelConfig {
  apiKey: string;
  baseUrl: string;
  providerId?: string;
  providerEnabled: boolean;
}
```

- [ ] **Step 1: Write failing provider-service tests**

Cover:

```ts
expect(listModelProviders()[0].maskedApiKey).toMatch(/^\*+/);
expect(JSON.stringify(listModelProviders())).not.toContain("plain-secret");
expect(resolveModelMember(modelId)).toMatchObject({
  apiKey: "plain-secret",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
});
```

Also assert that updating a provider key does not clear member capability data, while changing a member model ID does clear it.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npx vitest run src/server/services/model-provider-service.test.ts src/server/services/model-config-service.test.ts --pool=threads --maxWorkers=1
```

Expected: FAIL because provider functions do not exist.

- [ ] **Step 3: Implement provider validation and credential resolution**

Use this input shape:

```ts
const providerInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  baseUrl: safeBaseUrlSchema,
  apiKey: z.string().max(4096).optional(),
  isEnabled: z.boolean().default(true),
});
```

`resolveModelMember` must select credentials with:

```sql
SELECT m.*, p.base_url provider_base_url, p.api_key_ciphertext provider_api_key,
       p.is_enabled provider_enabled
FROM model_configs m
LEFT JOIN model_providers p ON p.id = m.provider_id
WHERE m.id = ?
```

Use provider credentials when `provider_id` exists; otherwise use the member's legacy credentials. Never include decrypted secrets in list APIs.

- [ ] **Step 4: Adapt legacy model CRUD**

Newly created legacy model configurations create or reuse a provider by exact Base URL and decrypted key equality, then store `provider_id`. Member edits accept `providerId`; Base URL/API Key edits update the provider only when explicitly sent. `getModelsForPurpose()` remains available but resolves provider credentials and orders purpose defaults first for backward compatibility.

- [ ] **Step 5: Run provider and compatibility tests**

Run:

```powershell
npx vitest run src/server/services/model-provider-service.test.ts src/server/services/model-config-service.test.ts src/server/services/model-capabilities.test.ts --pool=threads --maxWorkers=1
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit provider separation**

```powershell
git add src/server/services/model-provider-service.ts src/server/services/model-provider-service.test.ts src/server/services/model-config-service.ts src/server/services/model-config-service.test.ts
git commit -m "feat: separate model provider credentials"
```

---

### Task 3: Install the Versioned Qianwen Free-Pool Preset

**Files:**
- Create: `src/server/services/qianwen-free-pool-preset.ts`
- Create: `src/server/services/qianwen-free-pool-preset.test.ts`
- Create: `src/server/services/model-pool-admin-service.ts`
- Create: `src/server/services/model-pool-admin-service.test.ts`

**Interfaces:**
- Produces: `QIANWEN_FREE_POOL_PRESET_VERSION = 1`.
- Produces: `installQianwenFreePool(): { created: string[]; updated: string[]; needsVerification: string[] }`.
- Produces: `verifyPoolMembers(ids: string[]): Promise<PoolVerificationResult[]>`.
- Produces: `listPoolMembers(purpose?)`, `updatePoolMember(id, raw)`, `getPoolSummary()`, `getModelPoolSettings()`, `updateModelPoolSettings(raw)`, `listModelUsageEvents(filter)`.

- [ ] **Step 1: Write failing preset and installer tests**

Assert that the preset contains every model listed in the approved spec with exact purpose, tier, thinking flag, 1,000,000 total Tokens, `0.95` safety ratio, and verified expiry dates. Assert OCR members have `memberType: "ocr"` and `poolEnabled: false`.

Installer behavior:

```ts
const first = installQianwenFreePool();
const second = installQianwenFreePool();
expect(first.created.length).toBeGreaterThan(0);
expect(second.created).toEqual([]);
expect(second.updated.length).toBeGreaterThan(0);
expect(db.prepare("SELECT COUNT(*) count FROM model_configs WHERE preset_key IS NOT NULL").get())
  .toEqual({ count: QIANWEN_FREE_POOL_PRESET.length });
```

Manually disable one member, add used Tokens, reinstall, and assert both values remain unchanged.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npx vitest run src/server/services/qianwen-free-pool-preset.test.ts src/server/services/model-pool-admin-service.test.ts --pool=threads --maxWorkers=1
```

Expected: FAIL because preset/admin modules do not exist.

- [ ] **Step 3: Encode the preset as immutable data**

Use:

```ts
export interface QianwenPresetMember {
  model: string;
  purpose: ModelPurpose;
  qualityTier: ModelQualityTier;
  thinkingMode: boolean;
  memberType: "general" | "ocr";
  quotaTotalTokens: number;
  initialUsedTokens?: number;
  quotaExpiresAt: string;
  priority: number;
}

export const QIANWEN_FREE_POOL_PRESET_VERSION = 1;
const OCT_08 = "2026-10-08T23:59:59+08:00";
const member = (
  model: string,
  purpose: ModelPurpose,
  qualityTier: ModelQualityTier,
  quotaExpiresAt: string,
  priority: number,
  thinkingMode = false,
  memberType: "general" | "ocr" = "general",
): QianwenPresetMember => ({
  model, purpose, qualityTier, thinkingMode, memberType,
  quotaTotalTokens: 1_000_000, quotaExpiresAt, priority,
});

export const QIANWEN_FREE_POOL_PRESET = Object.freeze<QianwenPresetMember[]>([
  { ...member("qwen3-vl-plus", "vision", "A", OCT_08, 10), initialUsedTokens: 803_700 },
  member("qwen3-vl-plus-2025-12-19", "vision", "A", OCT_08, 20),
  member("qwen3-vl-plus-2025-09-23", "vision", "A", OCT_08, 30),
  member("qwen3-vl-235b-a22b-instruct", "vision", "A", OCT_08, 40),
  member("qwen3-vl-235b-a22b-thinking", "vision", "A", OCT_08, 50, true),
  member("qwen3-vl-32b-instruct", "vision", "A", OCT_08, 60),
  member("qwen3-vl-32b-thinking", "vision", "A", OCT_08, 70, true),
  member("qwen3-vl-30b-a3b-instruct", "vision", "A", OCT_08, 80),
  member("qwen3-vl-30b-a3b-thinking", "vision", "A", OCT_08, 90, true),
  member("qwen3.5-omni-plus", "vision", "A", OCT_08, 100),
  member("qwen3.5-omni-plus-2026-03-15", "vision", "A", OCT_08, 110),
  member("qwen-vl-max-2025-08-13", "vision", "A", OCT_08, 120),
  member("qwen-vl-max-2025-04-08", "vision", "A", OCT_08, 130),
  member("qwen3-vl-flash", "vision", "B", OCT_08, 140),
  member("qwen3-vl-flash-2026-01-22", "vision", "B", OCT_08, 150),
  member("qwen3-vl-flash-2025-10-15", "vision", "B", OCT_08, 160),
  member("qwen3.5-omni-flash", "vision", "B", OCT_08, 170),
  member("qwen3.5-omni-flash-2026-03-15", "vision", "B", OCT_08, 180),
  member("qwen3-vl-8b-instruct", "vision", "C", OCT_08, 190),
  member("qwen3-vl-8b-thinking", "vision", "C", OCT_08, 200, true),
  member("qwen3.5-ocr", "vision", "C", OCT_08, 210, false, "ocr"),
  member("qwen-vl-ocr", "vision", "C", OCT_08, 220, false, "ocr"),
  { ...member("qwen-plus", "text", "A", OCT_08, 10), initialUsedTokens: 333_600 },
  member("qwen3.7-max-2026-06-08", "text", "A", OCT_08, 20),
  member("qwen3.7-max-2026-05-20", "text", "A", OCT_08, 30),
  member("qwen3.7-max-2026-05-17", "text", "A", OCT_08, 40),
  member("qwen3.7-max", "text", "A", OCT_08, 50),
  member("qwen3-max-2026-01-23", "text", "A", OCT_08, 60),
  member("qwen3.7-plus-2026-05-26", "text", "A", OCT_08, 70),
  member("qwen3.7-plus", "text", "A", OCT_08, 80),
  member("deepseek-v4-pro", "text", "A", OCT_08, 90),
  member("deepseek-v3.2", "text", "A", OCT_08, 100),
  member("glm-5.2", "text", "A", OCT_08, 110),
  member("glm-5.1", "text", "A", OCT_08, 120),
  member("glm-5", "text", "A", OCT_08, 130),
  member("kimi-k2.6", "text", "A", OCT_08, 140),
  member("kimi-k2.5", "text", "A", OCT_08, 150),
  member("MiniMax-M2.5", "text", "A", OCT_08, 160),
  member("qwen3.6-plus-2026-04-02", "text", "A", OCT_08, 170),
  member("qwen3.5-plus-2026-04-20", "text", "A", OCT_08, 180),
  member("qwen3-235b-a22b-instruct-2507", "text", "A", OCT_08, 190),
  member("qwen3-next-80b-a3b-instruct", "text", "A", OCT_08, 200),
  member("qwen3.7-flash", "text", "B", "2026-10-23T23:59:59+08:00", 210),
  member("qwen3.7-flash-2026-07-15", "text", "B", "2026-10-23T23:59:59+08:00", 220),
  member("deepseek-v4-flash-0731", "text", "B", "2026-10-31T23:59:59+08:00", 230),
  member("qwen3.8-max", "text", "A", "2026-11-01T23:59:59+08:00", 240),
  member("deepseek-v4-pro-0813", "text", "A", "2026-11-13T23:59:59+08:00", 250),
  member("kimi-k3", "text", "A", "2026-11-18T23:59:59+08:00", 260),
  member("glm-5.3", "text", "A", "2026-11-23T23:59:59+08:00", 270),
  member("qwen3.8-flash", "text", "B", "2026-11-25T23:59:59+08:00", 280),
  member("qwen3.8-max-0902", "text", "A", "2026-12-01T23:59:59+08:00", 290),
]);
```

The implementation must contain the complete approved list; no generated names, wildcard aliases, or omitted dated variants.

- [ ] **Step 4: Implement idempotent installation**

Find the enabled provider whose Base URL host is `dashscope.aliyuncs.com`; if absent, throw `请先配置并启用千问服务商凭证`. Upsert by `(provider_id, purpose, model)`.

On create, set free billing, preset metadata, `pool_enabled = 0`, null capability state, and `initialUsedTokens ?? 0`. When adopting a pre-existing `qwen3-vl-plus` or `qwen-plus` row whose `preset_key` is null and `quota_used_tokens` is zero, initialize usage from the September 16, 2026 account snapshot. On later updates, change only preset-owned fields: tier, thinking, member type, total quota, expiry, safety ratio, priority, and preset version. Do not overwrite `pool_enabled`, `is_enabled`, usage, capability, cooldown, or failure counters.

- [ ] **Step 5: Implement bounded capability verification**

`verifyPoolMembers(ids)` validates at most 50 unique IDs per request and runs checks with concurrency `2`. A member becomes pool-enabled only when required capabilities pass:

```ts
const passed = capabilities.text && capabilities.json
  && (member.purpose === "text" || capabilities.vision);
```

Preserve explicit manual disable by accepting `{ enablePassed: boolean }`; the install UI sends `true` only for newly created members.

- [ ] **Step 6: Run preset/admin tests**

Run:

```powershell
npx vitest run src/server/services/qianwen-free-pool-preset.test.ts src/server/services/model-pool-admin-service.test.ts src/server/services/model-capabilities.test.ts --pool=threads --maxWorkers=1
```

Expected: PASS.

- [ ] **Step 7: Commit the preset installer**

```powershell
git add src/server/services/qianwen-free-pool-preset.ts src/server/services/qianwen-free-pool-preset.test.ts src/server/services/model-pool-admin-service.ts src/server/services/model-pool-admin-service.test.ts
git commit -m "feat: install qianwen free model pool"
```

---

### Task 4: Build the Free-First Model Router and Paid Budget Guard

**Files:**
- Create: `src/server/services/model-pool-service.ts`
- Create: `src/server/services/model-pool-service.test.ts`
- Modify: `src/server/ai/model-budget.ts`
- Modify: `src/server/ai/openai-compatible-client.ts`
- Modify: `src/server/ai/openai-compatible-client.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ModelPoolCallOptions {
  purpose: ModelPurpose;
  recordId?: string;
  fieldId?: string;
  operation: string;
  signal?: AbortSignal;
  validate?: (content: string) => { valid: boolean; repairedContent?: string };
}

export async function callModelPool(
  messages: unknown[],
  options: ModelPoolCallOptions,
): Promise<ModelRouteResult>;
```

- Produces a separate batch-level `withPaidTokenBudget(work, { maxPaidTokens })`; the existing per-field request-count budget remains unchanged.
- Produces structured error codes: `auth`, `quota_exhausted`, `rate_limit`, `timeout`, `network`, `service`, `configuration`, `invalid_output`, `budget`, `cancelled`, `model`.

- [ ] **Step 1: Write candidate-order and eligibility tests**

Use an exported pure helper:

```ts
export function rankPoolCandidates(
  members: ResolvedPoolMember[],
  options: {
    now: number;
    allowPaid: boolean;
    failedMemberIds: ReadonlySet<string>;
  },
): ResolvedPoolMember[];
```

Tests must prove:

- expired and 95%-used free members are excluded;
- cooldown and stale/failed capabilities are excluded;
- earlier expiry wins;
- equal expiry uses lower remaining quota first;
- A before B before C;
- non-thinking before thinking;
- thinking is absent while an eligible non-thinking free member exists;
- paid members are last and absent when paid allowance is zero.

- [ ] **Step 2: Write router behavior tests**

Mock `callVisionModel` and assert:

```ts
expect(callVisionModel).toHaveBeenCalledTimes(1); // first candidate succeeds
```

Add explicit cases for quota exhaustion switch, 429 cooldown/switch, one retry then switch for 5xx/timeout, provider disable on 401/403, member disable on 400/404/model-not-found, invalid-output local repair then one retry, cancellation without switch, unknown usage event, and paid-blocked behavior.

- [ ] **Step 3: Run router tests and verify failure**

Run:

```powershell
npx vitest run src/server/services/model-pool-service.test.ts src/server/ai/openai-compatible-client.test.ts --pool=threads --maxWorkers=1
```

Expected: FAIL because the router and new error codes do not exist.

- [ ] **Step 4: Normalize provider errors and usage**

Change `classifyModelError` to return:

```ts
interface ClassifiedModelError {
  code: "auth" | "quota_exhausted" | "rate_limit" | "timeout" | "network"
    | "service" | "configuration" | "budget" | "cancelled" | "model";
  message: string;
  retryable: boolean;
  httpStatus?: number;
}
```

Detect quota exhaustion before generic 429 using provider messages such as `insufficient_quota`, `quota exhausted`, `free quota`, `余额不足`, and `额度用尽`. Preserve `prompt_tokens` and `completion_tokens` as optional non-negative integers.

- [ ] **Step 5: Add a separate paid-Token budget context**

Keep the existing `ModelBudget` request-count interface unchanged. Add a second `AsyncLocalStorage` context in the same module:

```ts
export interface PaidTokenBudget {
  reservePaidTokens: (tokens: number) => void;
  settlePaidTokens: (reserved: number, actual: number) => void;
  paidTokensUsed: () => number;
}

export function withPaidTokenBudget<T>(
  work: () => Promise<T>,
  options?: { maxPaidTokens?: number },
): Promise<T>;
```

The paid limit is `0` when no paid context exists. Reservation must occur before a paid request using the member's `maxTokens`; settlement replaces the reservation with actual prompt plus completion Tokens. A reservation that exceeds the batch limit throws `ModelBudgetExceeded` before transport is called. This context must remain separate because `withModelBudget` limits one field to at most six requests, while one batch can contain thousands of fields.

- [ ] **Step 6: Implement routing and event accounting**

For each candidate:

1. Check cancellation and request budget.
2. Reserve paid Tokens if needed and verify daily/monthly totals from `model_usage_events`.
3. Call `callVisionModel(member, messages, { attempts: 1, signal })`.
4. Run local validator/repair.
5. On success, atomically increment free quota when usage exists, reset failure state, insert `success`, settle paid reservation, and return.
6. On failure, settle reservation to zero when no billable response exists, apply the exact error policy, insert `failure` plus `switch` when another candidate will be tried.

For paid responses without usage, keep the full `maxTokens` reservation as `accounted_tokens` and insert `usage_unknown`; for free responses without usage, set `accounted_tokens = 0` and do not decrement quota. Daily/monthly paid totals sum `accounted_tokens` for paid members.

Cooldown formula:

```ts
const seconds = Math.min(1800, 60 * 2 ** Math.max(0, consecutiveFailures));
```

Transient 408/network/5xx errors get one retry on the same member before cooldown. No other category gets an implicit retry.

- [ ] **Step 7: Run router, budget, and client tests**

Run:

```powershell
npx vitest run src/server/services/model-pool-service.test.ts src/server/ai/openai-compatible-client.test.ts --pool=threads --maxWorkers=1
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit routing**

```powershell
git add src/server/services/model-pool-service.ts src/server/services/model-pool-service.test.ts src/server/ai/model-budget.ts src/server/ai/openai-compatible-client.ts src/server/ai/openai-compatible-client.test.ts
git commit -m "feat: route calls through free model pools"
```

---

### Task 5: Route Field, Lost-Deal, and Reception-Quality Analysis

**Files:**
- Modify: `src/server/services/field-analysis-service.ts`
- Modify: `src/server/services/field-analysis-service.test.ts`
- Modify: `src/server/services/lost-deal-attribution.test.ts`
- Modify: `src/server/services/reception-quality.test.ts`

**Interfaces:**
- Consumes: `callModelPool(messages, options)`.
- Preserves existing field-run result, raw response, Token totals, status, and model snapshot formats.
- Adds the chosen model and route attempts to `modelConfigSnapshot`.

- [ ] **Step 1: Replace test mocks with the unified router**

Mock:

```ts
vi.mock("./model-pool-service", () => ({ callModelPool: vi.fn() }));
```

Add assertions that image fields use `purpose: "vision"`, derived/text fields use `purpose: "text"`, `recordId` and `fieldId` are passed, and the three current hand-written candidate loops are gone.

- [ ] **Step 2: Run affected tests and verify failure**

Run:

```powershell
npx vitest run src/server/services/field-analysis-service.test.ts src/server/services/lost-deal-attribution.test.ts src/server/services/reception-quality.test.ts --pool=threads --maxWorkers=1
```

Expected: FAIL because services still call `getModelsForPurpose` and `callVisionModel`.

- [ ] **Step 3: Integrate the router**

Use:

```ts
const routed = await callModelPool(messages, {
  purpose: field.imageEnabled ? "vision" : "text",
  recordId,
  fieldId: field.id,
  operation: field.executionType,
});
```

For lost-deal attribution and reception-quality parsing, pass a validator that reports parser failures as invalid output, allowing the router's single controlled retry/switch. Do not classify evidence-insufficient business results as model failures; those remain `needs_review`.

Save:

```ts
modelConfigSnapshot: {
  id: routed.model.id,
  name: routed.model.name,
  model: routed.model.model,
  purpose: routed.model.purpose,
  attempts: routed.attempts,
}
```

- [ ] **Step 4: Verify field-analysis regressions**

Run:

```powershell
npx vitest run src/server/services/field-analysis-service.test.ts src/server/services/lost-deal-attribution.test.ts src/server/services/reception-quality.test.ts --pool=threads --maxWorkers=1
npm run typecheck
```

Expected: PASS and no direct model loop remains in `field-analysis-service.ts`.

- [ ] **Step 5: Commit field integration**

```powershell
git add src/server/services/field-analysis-service.ts src/server/services/field-analysis-service.test.ts src/server/services/lost-deal-attribution.test.ts src/server/services/reception-quality.test.ts
git commit -m "refactor: route analysis through model pool"
```

---

### Task 6: Route Knowledge Matching and High-Frequency Question Capture

**Files:**
- Modify: `src/server/services/knowledge/knowledge-match-service.ts`
- Modify: `src/server/services/knowledge/knowledge-match-service.test.ts`
- Modify: `src/server/services/knowledge/hot-topic-service.ts`
- Modify: `src/server/services/knowledge/hot-topic-service.test.ts`
- Modify: `src/server/services/knowledge/knowledge-flow.integration.test.ts`

**Interfaces:**
- Consumes: `callModelPool`.
- Preserves knowledge matching cache behavior and high-frequency-question transaction/serialization behavior.
- Uses one route result per logical `ask`; a later logical `ask` may select a different healthy member.

- [ ] **Step 1: Write failing routing tests**

For matching, assert one successful route and no second member call. For hot topics, configure two logical `ask` calls and assert each saves its selected model/attempts while aggregate input/output Tokens remain correct.

Add a failover case where the first text member returns 429 and the second succeeds; assert the knowledge item is written once.

- [ ] **Step 2: Run knowledge tests and verify failure**

Run:

```powershell
npx vitest run src/server/services/knowledge/knowledge-match-service.test.ts src/server/services/knowledge/hot-topic-service.test.ts src/server/services/knowledge/knowledge-flow.integration.test.ts --pool=threads --maxWorkers=1
```

Expected: FAIL because direct model loops remain.

- [ ] **Step 3: Replace direct loops**

Knowledge matching:

```ts
const routed = await callModelPool(messages, {
  purpose: "text",
  recordId: input.recordId,
  fieldId: input.field.id,
  operation: "knowledge_match",
});
```

Hot-topic `ask`:

```ts
const routed = await callModelPool([
  { role: "system", content: system },
  { role: "user", content: JSON.stringify(data) },
], {
  purpose: "text",
  recordId,
  fieldId: field.id,
  operation: "hot_topic_capture",
});
```

Append `routed.raw`, selected model snapshot, attempts, and usage exactly once per logical call.

- [ ] **Step 4: Run knowledge regression tests**

Run:

```powershell
npx vitest run src/server/services/knowledge/knowledge-match-service.test.ts src/server/services/knowledge/hot-topic-service.test.ts src/server/services/knowledge/knowledge-flow.integration.test.ts --pool=threads --maxWorkers=1
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit knowledge integration**

```powershell
git add src/server/services/knowledge/knowledge-match-service.ts src/server/services/knowledge/knowledge-match-service.test.ts src/server/services/knowledge/hot-topic-service.ts src/server/services/knowledge/hot-topic-service.test.ts src/server/services/knowledge/knowledge-flow.integration.test.ts
git commit -m "refactor: route knowledge calls through model pool"
```

---

### Task 7: Expose Model-Pool Administration APIs

**Files:**
- Create: `src/server/routes/model-pool-router.ts`
- Create: `src/server/routes/model-pool-router.test.ts`
- Modify: `src/server/app.ts`

**Interfaces:**
- Produces:
  - `GET /api/model-providers`
  - `POST /api/model-providers`
  - `PATCH /api/model-providers/:id`
  - `POST /api/model-providers/:id/test`
  - `GET /api/model-pools`
  - `PATCH /api/model-pool-members/:id`
  - `POST /api/model-pools/qianwen-free/install`
  - `POST /api/model-pools/qianwen-free/verify`
  - `GET /api/model-pool-settings`
  - `PATCH /api/model-pool-settings`
  - `GET /api/model-usage-events`
- Preserves all `/api/model-configs` routes.

- [ ] **Step 1: Write route tests**

Assert:

- provider responses contain `maskedApiKey` and never `apiKey`;
- preset install returns created/updated/needs-verification lists;
- verify rejects more than 50 IDs;
- pool member patch accepts only enabled, pool-enabled, tier, priority, safety ratio, quota total/used/expiry, and billing fields;
- budget settings reject negatives and unsafe integers;
- event filters accept purpose, event type, model ID, `limit <= 200`, and cursor.

- [ ] **Step 2: Run route tests and verify failure**

Run:

```powershell
npx vitest run src/server/routes/model-pool-router.test.ts --pool=threads --maxWorkers=1
```

Expected: FAIL because the router does not exist.

- [ ] **Step 3: Implement the Express router**

Use Zod request schemas and the existing `{ success, data }` / `{ success: false, error }` response convention. Return HTTP 400 for validation, 404 for missing provider/member, and 409 when a Qianwen preset install has no reusable provider.

- [ ] **Step 4: Mount the router**

In `src/server/app.ts`, mount:

```ts
app.use("/api", createModelPoolRouter());
```

before the static-file middleware. Do not remove legacy endpoints.

- [ ] **Step 5: Run route and app tests**

Run:

```powershell
npx vitest run src/server/routes/model-pool-router.test.ts src/client/App.test.tsx --pool=threads --maxWorkers=1
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit APIs**

```powershell
git add src/server/routes/model-pool-router.ts src/server/routes/model-pool-router.test.ts src/server/app.ts
git commit -m "feat: expose model pool administration api"
```

---

### Task 8: Rebuild the Model Configuration Console

**Files:**
- Create: `src/client/components/model-config/ProviderView.tsx`
- Create: `src/client/components/model-config/PoolView.tsx`
- Create: `src/client/components/model-config/UsageView.tsx`
- Create: `src/client/components/ModelConfigDialog.test.tsx`
- Modify: `src/client/components/ModelConfigDialog.tsx`
- Modify: `src/client/hooks/useModelReadiness.ts`
- Modify: `src/client/styles.css`

**Interfaces:**
- Consumes all Task 7 APIs.
- Keeps `ModelConfigDialog({ models, close, saved })` so the parent does not require an immediate contract rewrite.
- Produces tabs `服务商凭证`, `模型池`, and `调用状态`.

- [ ] **Step 1: Write failing UI tests**

Test:

- opening defaults to `模型池`;
- `安装/更新千问免费池` displays created count and then verifies only `needsVerification`;
- provider form never renders an existing full key;
- purpose tabs filter vision/text members;
- row edits send tier, priority, enable, quota, and billing fields;
- usage filters request purpose/model/status;
- paid models and exhausted/cooldown/capability-failed members have distinct text statuses;
- readiness is true when any verified eligible member exists, without requiring `isPurposeDefault`.

- [ ] **Step 2: Run UI tests and verify failure**

Run:

```powershell
npx vitest run src/client/components/ModelConfigDialog.test.tsx src/client/hooks/useModelReadiness.test.ts --pool=threads --maxWorkers=1
```

Expected: FAIL because the three-view console does not exist. If `useModelReadiness.test.ts` does not exist, create it in this step.

- [ ] **Step 3: Implement the dialog shell and provider view**

Use a compact tablist. Provider rows show name, Base URL, masked key, enabled state, last test time/error, and commands for edit/test. API Key inputs are blank password fields with `留空则保留原 Key`.

- [ ] **Step 4: Implement the pool view**

Use vision/text segmented tabs and a dense table with:

```text
模型 | 等级 | 计费 | 已用/总额 | 剩余 | 到期 | 能力 | 冷却 | 优先级 | 状态 | 操作
```

The install command first calls `/install`, then calls `/verify` with only newly created IDs in chunks of at most 50. Show verification progress and refresh after completion. Do not automatically re-enable pre-existing manually disabled members.

- [ ] **Step 5: Implement usage/status view**

Show newest events first with filters for purpose, model, and event type. Display model, operation, event, input/output Tokens, error code, record/field reference, duration, and time. Do not expose raw prompt, raw response, or credentials.

- [ ] **Step 6: Update readiness and styles**

Readiness requires:

```ts
const eligible = model.isEnabled
  && model.poolEnabled
  && model.capabilityEligible
  && !model.quotaBlocked
  && !model.cooldownUntil;
```

Use full-width unframed tab sections, table rows, restrained status colors, maximum `8px` radius, responsive horizontal scrolling, and no nested cards.

- [ ] **Step 7: Run UI tests and build**

Run:

```powershell
npx vitest run src/client/components/ModelConfigDialog.test.tsx src/client/hooks/useModelReadiness.test.ts src/client/App.test.tsx --pool=threads --maxWorkers=1
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit the model console**

```powershell
git add src/client/components/model-config src/client/components/ModelConfigDialog.tsx src/client/components/ModelConfigDialog.test.tsx src/client/hooks/useModelReadiness.ts src/client/hooks/useModelReadiness.test.ts src/client/styles.css
git commit -m "feat: rebuild model pool console"
```

---

### Task 9: Add Explicit Batch Paid-Token Controls

**Files:**
- Modify: `src/client/components/AnalysisRunDialog.tsx`
- Modify: `src/client/components/AnalysisRunDialog.test.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/server/app.ts`
- Modify: `src/server/services/batch-analysis-service.ts`
- Modify: `src/server/services/batch-analysis-service.test.ts`

**Interfaces:**
- Consumes `AnalysisJobOptions.maxPaidTokens`.
- Passes the batch value into one root `withPaidTokenBudget` context while retaining separate per-field `withModelBudget` request limits.
- Default is `0`; no paid call is possible when the user does not change it.

- [ ] **Step 1: Write failing paid-budget flow tests**

Assert the dialog initializes `maxPaidTokens` to `0`, warns that free-pool exhaustion will pause the task, rejects negative/non-integer values, and submits:

```ts
{ concurrency, batchSize, maxPaidTokens: 0 }
```

At the batch-service level, assert `resolveAnalysisRunOptions()` preserves a safe integer from `0` through `100_000_000`, defaults invalid input to `0`, and that `analyzeJob()` passes it to `withPaidTokenBudget`.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npx vitest run src/client/components/AnalysisRunDialog.test.tsx src/server/services/batch-analysis-service.test.ts --pool=threads --maxWorkers=1
```

Expected: FAIL because the dialog and job runner do not pass paid limits.

- [ ] **Step 3: Implement the batch budget control**

Add a numeric `最大付费 Token` input with minimum `0`, step `1000`, and explanatory text:

```text
0 表示仅使用免费池；免费额度不可用时任务暂停并等待处理。
```

Update `onConfirm` and the job start payload to include `maxPaidTokens`.

- [ ] **Step 4: Bind the job root to the paid budget**

Extend `resolveAnalysisRunOptions()` to return `maxPaidTokens`, forward `req.body.maxPaidTokens` from `/api/jobs/:id/analyze`, and wrap the prepared batch:

```ts
const prepared = prepareAcquiredAnalysisJob(jobId, sectionId, options);
return withPaidTokenBudget(
  () => runPreparedAnalysisJob(prepared),
  { maxPaidTokens: prepared.runOptions.maxPaidTokens },
);
```

The API forwarding object must be:

```ts
{
  concurrency: req.body.concurrency,
  batchSize: req.body.batchSize,
  maxPaidTokens: req.body.maxPaidTokens,
}
```

Per-field `withModelBudget` calls continue to enforce their current request and timeout limits independently.

- [ ] **Step 5: Verify paid-budget flow**

Run:

```powershell
npx vitest run src/client/components/AnalysisRunDialog.test.tsx src/server/services/batch-analysis-service.test.ts src/server/services/model-pool-service.test.ts --pool=threads --maxWorkers=1
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit budget controls**

```powershell
git add src/client/components/AnalysisRunDialog.tsx src/client/components/AnalysisRunDialog.test.tsx src/client/App.tsx src/server/app.ts src/server/services/batch-analysis-service.ts src/server/services/batch-analysis-service.test.ts
git commit -m "feat: require explicit paid model budget"
```

---

### Task 10: Verify Migration, Regression Safety, and Runtime Behavior

**Files:**
- Modify only files required by failures found in this task.
- Review: `docs/superpowers/specs/2026-09-16-model-pool-design.md`
- Review: `docs/superpowers/plans/2026-09-16-model-pool.md`

**Interfaces:**
- Validates every approved spec requirement against the finished system.

- [ ] **Step 1: Run focused model-pool tests**

Run:

```powershell
npx vitest run src/server/db/migrations/migrations.test.ts src/server/services/model-provider-service.test.ts src/server/services/qianwen-free-pool-preset.test.ts src/server/services/model-pool-admin-service.test.ts src/server/services/model-pool-service.test.ts src/server/routes/model-pool-router.test.ts src/client/components/ModelConfigDialog.test.tsx --pool=threads --maxWorkers=1
```

Expected: PASS.

- [ ] **Step 2: Run affected business regressions**

Run:

```powershell
npx vitest run src/server/services/field-analysis-service.test.ts src/server/services/lost-deal-attribution.test.ts src/server/services/reception-quality.test.ts src/server/services/knowledge/knowledge-match-service.test.ts src/server/services/knowledge/hot-topic-service.test.ts src/server/services/knowledge/knowledge-flow.integration.test.ts --pool=threads --maxWorkers=1
```

Expected: PASS.

- [ ] **Step 3: Run the full static and test suite**

Run:

```powershell
npm run typecheck
npm run build
npx vitest run --pool=threads --maxWorkers=1
```

Expected: all commands PASS.

- [ ] **Step 4: Verify the real database migration with backup**

Stop the local server, then run:

```powershell
npm run db:migrations
npm run db:check
```

Expected: schema version 14, integrity check `ok`, and a pre-v14 migration backup under the configured database `backups/migrations` directory.

- [ ] **Step 5: Start the application and perform the operator smoke test**

Run:

```powershell
npm run dev
```

Verify:

1. The existing Qianwen credential appears once under `服务商凭证`.
2. `安装/更新千问免费池` is idempotent.
3. Newly verified members appear in vision/text pools.
4. The current `qwen3-vl-plus` and `qwen-plus` local usage values are preserved or entered from the approved snapshot.
5. A one-record vision analysis stops after the first successful model.
6. Simulated paid fallback with batch budget `0` is blocked before transport.
7. Usage events show selected model, Tokens, and any switch reason.

- [ ] **Step 6: Inspect the final diff for credential leakage and unintended changes**

Run:

```powershell
git diff --check
git status --short
git diff -- src/server/services/model-pool-service.ts src/server/services/model-provider-service.ts src/client/components/ModelConfigDialog.tsx
```

Expected: no whitespace errors, no full API key, no unrelated file deletion, and no reset of pre-existing user changes.

- [ ] **Step 7: Commit verification fixes if any**

If verification required code changes, inspect `git diff --name-only`, stage only the model-pool files changed during this verification step, and commit them with `git commit -m "fix: complete model pool verification"`. If no changes were required, do not create an empty commit.
