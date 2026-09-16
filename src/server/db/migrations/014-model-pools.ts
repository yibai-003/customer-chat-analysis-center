import crypto from "node:crypto";

function providerId(baseUrl: string, ciphertext: string) {
  return `provider-${crypto.createHash("sha256").update(`${baseUrl}\0${ciphertext}`).digest("hex").slice(0, 32)}`;
}

function isDashScope(baseUrl: string) {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "dashscope.aliyuncs.com";
  } catch {
    return false;
  }
}

export function applyModelPools(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_providers (
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

    CREATE TABLE IF NOT EXISTS model_usage_events (
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

    CREATE INDEX IF NOT EXISTS idx_model_usage_events_created_at
      ON model_usage_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_model_usage_events_model
      ON model_usage_events(model_config_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS model_pool_settings (
      id TEXT PRIMARY KEY CHECK (id = 'default'),
      paid_daily_token_limit INTEGER NOT NULL DEFAULT 0,
      paid_monthly_token_limit INTEGER NOT NULL DEFAULT 0,
      capability_ttl_ms INTEGER NOT NULL DEFAULT 86400000,
      updated_at TEXT NOT NULL
    );
  `);

  const modelColumns = new Set(
    (db.prepare("PRAGMA table_info(model_configs)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  const columns: Array<[string, string]> = [
    ["provider_id", "TEXT REFERENCES model_providers(id)"],
    ["pool_enabled", "INTEGER NOT NULL DEFAULT 0"],
    ["billing_mode", "TEXT NOT NULL DEFAULT 'paid' CHECK (billing_mode IN ('free','paid'))"],
    ["quality_tier", "TEXT NOT NULL DEFAULT 'A' CHECK (quality_tier IN ('A','B','C'))"],
    ["priority", "INTEGER NOT NULL DEFAULT 100"],
    ["thinking_mode", "INTEGER NOT NULL DEFAULT 0"],
    ["member_type", "TEXT NOT NULL DEFAULT 'general' CHECK (member_type IN ('general','ocr'))"],
    ["quota_total_tokens", "INTEGER"],
    ["quota_used_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["quota_expires_at", "TEXT"],
    ["quota_safety_ratio", "REAL NOT NULL DEFAULT 0.95"],
    ["quota_exhausted_at", "TEXT"],
    ["cooldown_until", "TEXT"],
    ["consecutive_failures", "INTEGER NOT NULL DEFAULT 0"],
    ["last_success_at", "TEXT"],
    ["last_failure_at", "TEXT"],
    ["preset_key", "TEXT"],
    ["preset_version", "INTEGER"],
  ];
  for (const [name, definition] of columns) {
    if (!modelColumns.has(name)) db.exec(`ALTER TABLE model_configs ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_model_configs_pool
      ON model_configs(purpose, pool_enabled, is_enabled);
  `);

  const now = new Date().toISOString();
  const modelRows = db.prepare(`
    SELECT id, name, base_url, api_key_ciphertext, purpose, is_purpose_default, is_enabled, created_at, updated_at
    FROM model_configs
    ORDER BY created_at, id
  `).all() as Array<{
    id: string;
    name: string;
    base_url: string;
    api_key_ciphertext: string;
    purpose: "vision" | "text";
    is_purpose_default: number;
    is_enabled: number;
    created_at: string;
    updated_at: string;
  }>;

  const createProvider = db.prepare(`
    INSERT OR IGNORE INTO model_providers
      (id, name, base_url, api_key_ciphertext, is_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `);
  const assignProvider = db.prepare("UPDATE model_configs SET provider_id = ? WHERE id = ?");
  const dashScopeDefault = modelRows.find((row) =>
    isDashScope(row.base_url) && row.is_enabled === 1 && row.is_purpose_default === 1,
  );
  const dashScopeRows = modelRows.filter((row) => isDashScope(row.base_url));
  if (dashScopeRows.length) {
    const source = dashScopeDefault ?? dashScopeRows[0];
    const id = "provider-dashscope";
    createProvider.run(id, "千问百炼", source.base_url, source.api_key_ciphertext, now, now);
    for (const row of dashScopeRows) assignProvider.run(id, row.id);
  }

  const otherProviders = new Map<string, { id: string; row: (typeof modelRows)[number] }>();
  for (const row of modelRows) {
    if (isDashScope(row.base_url)) continue;
    const key = `${row.base_url}\0${row.api_key_ciphertext}`;
    const existing = otherProviders.get(key);
    if (existing) {
      assignProvider.run(existing.id, row.id);
      continue;
    }
    const id = providerId(row.base_url, row.api_key_ciphertext);
    otherProviders.set(key, { id, row });
    createProvider.run(id, row.name, row.base_url, row.api_key_ciphertext, now, now);
    assignProvider.run(id, row.id);
  }

  db.prepare(`
    INSERT OR IGNORE INTO model_pool_settings
      (id, paid_daily_token_limit, paid_monthly_token_limit, capability_ttl_ms, updated_at)
    VALUES ('default', 0, 0, 86400000, ?)
  `).run(now);
}
