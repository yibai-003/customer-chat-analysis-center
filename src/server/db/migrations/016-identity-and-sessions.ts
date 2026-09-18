const ORG_ID = "org-default";

const OWNED_TABLES = [
  "jobs",
  "import_jobs",
  "records",
  "analysis_sections",
  "analysis_fields",
  "model_configs",
  "model_providers",
  "knowledge_bases",
  "knowledge_items",
];

export function applyIdentityAndSessions(db: any) {
  const now = new Date().toISOString();
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      password_hash TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (organization_id, username)
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT REFERENCES organizations(id),
      actor_user_id TEXT REFERENCES users(id),
      actor_display TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      outcome TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      correlation_id TEXT,
      occurred_at TEXT NOT NULL
    );
  `);
  const organization = db.prepare("SELECT id FROM organizations WHERE id = ?").get(ORG_ID);
  if (!organization) {
    db.prepare("INSERT INTO organizations(id,name,is_active,created_at,updated_at) VALUES(?,?,1,?,?)")
      .run(ORG_ID, "默认组织", now, now);
  }
  for (const table of OWNED_TABLES) {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!columns.has("organization_id")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN organization_id TEXT REFERENCES organizations(id)`);
    }
    if (!columns.has("created_by_user_id")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN created_by_user_id TEXT REFERENCES users(id)`);
    }
    // Legacy rows have no historical creator: keep created_by_user_id NULL (system/unassigned).
    db.prepare(`UPDATE ${table} SET organization_id = ? WHERE organization_id IS NULL`).run(ORG_ID);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_events_org_time ON audit_events(organization_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_user_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_org_default_target ON organizations(is_active);
  `);
}