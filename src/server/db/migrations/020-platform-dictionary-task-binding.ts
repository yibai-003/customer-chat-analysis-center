export function applyPlatformDictionaryAndTaskBinding(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS platforms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL COLLATE NOCASE,
      is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platforms_code ON platforms(code COLLATE NOCASE);
  `);

  const jobColumns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!jobColumns.some((column) => column.name === "platform_id")) {
    db.exec("ALTER TABLE jobs ADD COLUMN platform_id TEXT REFERENCES platforms(id) ON DELETE RESTRICT");
  }
  if (!jobColumns.some((column) => column.name === "platform_code")) {
    db.exec("ALTER TABLE jobs ADD COLUMN platform_code TEXT");
  }
  if (!jobColumns.some((column) => column.name === "platform_name")) {
    db.exec("ALTER TABLE jobs ADD COLUMN platform_name TEXT");
  }

  const importJobColumns = db.prepare("PRAGMA table_info(import_jobs)").all() as Array<{ name: string }>;
  if (!importJobColumns.some((column) => column.name === "section_config_version_id")) {
    db.exec("ALTER TABLE import_jobs ADD COLUMN section_config_version_id TEXT REFERENCES analysis_section_versions(id) ON DELETE RESTRICT");
  }
  if (!importJobColumns.some((column) => column.name === "platform_id")) {
    db.exec("ALTER TABLE import_jobs ADD COLUMN platform_id TEXT REFERENCES platforms(id) ON DELETE RESTRICT");
  }
  if (!importJobColumns.some((column) => column.name === "platform_code")) {
    db.exec("ALTER TABLE import_jobs ADD COLUMN platform_code TEXT");
  }
  if (!importJobColumns.some((column) => column.name === "platform_name")) {
    db.exec("ALTER TABLE import_jobs ADD COLUMN platform_name TEXT");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_jobs_platform_id ON jobs(platform_id);
    CREATE INDEX IF NOT EXISTS idx_import_jobs_platform_id ON import_jobs(platform_id);
    CREATE INDEX IF NOT EXISTS idx_import_jobs_section_version ON import_jobs(section_config_version_id);
  `);
}
