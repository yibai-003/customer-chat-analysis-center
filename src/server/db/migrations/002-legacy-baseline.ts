export function applyLegacyBaseline(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_configs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
      api_key_ciphertext TEXT NOT NULL, model TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'vision',
      is_purpose_default INTEGER NOT NULL DEFAULT 0,
      supports_vision INTEGER NOT NULL DEFAULT 1, temperature REAL NOT NULL DEFAULT 0.2,
      max_tokens INTEGER NOT NULL DEFAULT 1500, is_default INTEGER NOT NULL DEFAULT 0,
      is_enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analysis_sections (
      id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL, prompt TEXT NOT NULL,
      output_schema_json TEXT NOT NULL, source_fields_json TEXT NOT NULL DEFAULT '[]', sort_order INTEGER NOT NULL DEFAULT 0,
      is_enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, original_filename TEXT NOT NULL, source_path TEXT NOT NULL,
      section_id TEXT, section_name TEXT,
      status TEXT NOT NULL, total_records INTEGER NOT NULL DEFAULT 0,
      completed_records INTEGER NOT NULL DEFAULT 0, failed_records INTEGER NOT NULL DEFAULT 0,
      total_fields INTEGER NOT NULL DEFAULT 0, completed_fields INTEGER NOT NULL DEFAULT 0,
      failed_fields INTEGER NOT NULL DEFAULT 0, skipped_fields INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS import_jobs (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, source_path TEXT NOT NULL,
      job_id TEXT, section_id TEXT, section_name TEXT, status TEXT NOT NULL DEFAULT 'queued',
      total_images INTEGER NOT NULL DEFAULT 0, processed_images INTEGER NOT NULL DEFAULT 0,
      failed_images INTEGER NOT NULL DEFAULT 0, total_records INTEGER NOT NULL DEFAULT 0,
      processed_records INTEGER NOT NULL DEFAULT 0, current_sheet TEXT, current_row INTEGER,
      error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(job_id)
    );
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, sheet_name TEXT NOT NULL,
      row_number INTEGER NOT NULL, anchor_json TEXT NOT NULL, source_fields_json TEXT NOT NULL,
      image_path TEXT NOT NULL, status TEXT NOT NULL, review_status TEXT NOT NULL,
      review_note TEXT NOT NULL DEFAULT '', human_result_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_records_job_status_row
    ON records(job_id, status, row_number);
    CREATE INDEX IF NOT EXISTS idx_records_job_review_row
    ON records(job_id, review_status, row_number);
    CREATE TABLE IF NOT EXISTS analysis_runs (
      id TEXT PRIMARY KEY, record_id TEXT NOT NULL, section_id TEXT NOT NULL,
      model_config_snapshot_json TEXT NOT NULL, prompt_snapshot TEXT NOT NULL,
      output_schema_snapshot_json TEXT NOT NULL, model_result_json TEXT NOT NULL,
      raw_response TEXT, error_message TEXT, duration_ms INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, status TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS record_section_reviews (
      record_id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      human_result_json TEXT,
      review_status TEXT NOT NULL DEFAULT 'pending',
      review_note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY(record_id, section_id),
      FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE,
      FOREIGN KEY(section_id) REFERENCES analysis_sections(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS analysis_fields (
      id TEXT PRIMARY KEY, section_id TEXT NOT NULL, key TEXT NOT NULL,
      label TEXT NOT NULL, field_type TEXT NOT NULL, prompt TEXT NOT NULL,
      options_json TEXT NOT NULL DEFAULT '[]', output_column TEXT,
      is_required INTEGER NOT NULL DEFAULT 0, image_enabled INTEGER NOT NULL DEFAULT 1,
      depends_on_json TEXT NOT NULL DEFAULT '[]', sort_order INTEGER NOT NULL DEFAULT 0,
      execution_type TEXT NOT NULL DEFAULT 'ai',
      export_enabled INTEGER NOT NULL DEFAULT 1,
      knowledge_base_id TEXT,
      candidate_limit INTEGER NOT NULL DEFAULT 15,
      match_field_key TEXT,
      knowledge_column TEXT,
      knowledge_sync_enabled INTEGER NOT NULL DEFAULT 0,
      knowledge_capture_limit INTEGER NOT NULL DEFAULT 2,
      is_enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(section_id, key),
      FOREIGN KEY(section_id) REFERENCES analysis_sections(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS knowledge_bases (
      id TEXT PRIMARY KEY, section_id TEXT NOT NULL, name TEXT NOT NULL,
      original_filename TEXT NOT NULL, column_schema_json TEXT NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0, is_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(section_id) REFERENCES analysis_sections(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS knowledge_imports (
      id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL,
      original_filename TEXT NOT NULL, source_path TEXT NOT NULL,
      sheet_name TEXT NOT NULL, summary_json TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS knowledge_items (
      id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL, path_key TEXT NOT NULL,
      values_json TEXT NOT NULL, search_text TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1, source_import_id TEXT,
      source_row_number INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(knowledge_base_id, path_key),
      FOREIGN KEY(knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      FOREIGN KEY(source_import_id) REFERENCES knowledge_imports(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_match_snapshots (
      id TEXT PRIMARY KEY, record_id TEXT NOT NULL, field_id TEXT NOT NULL,
      knowledge_base_id TEXT NOT NULL, knowledge_item_id TEXT NOT NULL,
      item_values_json TEXT NOT NULL, candidate_snapshot_json TEXT NOT NULL,
      query_snapshot TEXT NOT NULL, model_response TEXT, created_at TEXT NOT NULL,
      FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE,
      FOREIGN KEY(field_id) REFERENCES analysis_fields(id) ON DELETE CASCADE
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_item_fts
    USING fts5(item_id UNINDEXED, knowledge_base_id UNINDEXED, search_text, tokenize='trigram');
    CREATE TABLE IF NOT EXISTS analysis_field_runs (
      id TEXT PRIMARY KEY, record_id TEXT NOT NULL, field_id TEXT NOT NULL,
      status TEXT NOT NULL, result_json TEXT NOT NULL, dependencies_json TEXT NOT NULL,
      evidence_text TEXT,
      prompt_snapshot TEXT NOT NULL, field_snapshot_json TEXT NOT NULL,
      model_config_snapshot_json TEXT NOT NULL, raw_response TEXT, error_message TEXT,
      duration_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, created_at TEXT NOT NULL,
      FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE,
      FOREIGN KEY(field_id) REFERENCES analysis_fields(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS hot_topic_record_questions (
      record_id TEXT NOT NULL, field_id TEXT NOT NULL, knowledge_item_id TEXT NOT NULL,
      question TEXT NOT NULL, evidence TEXT NOT NULL, origin TEXT NOT NULL,
      PRIMARY KEY(record_id, field_id, knowledge_item_id),
      FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE,
      FOREIGN KEY(field_id) REFERENCES analysis_fields(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hot_topic_questions_item ON hot_topic_record_questions(knowledge_item_id);
  `);
  const sectionColumns = db.prepare("PRAGMA table_info(analysis_sections)").all() as Array<{ name: string }>;
  if (!sectionColumns.some((column) => column.name === "source_fields_json")) {
    db.exec("ALTER TABLE analysis_sections ADD COLUMN source_fields_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!sectionColumns.some((column) => column.name === "image_enabled")) {
    db.exec("ALTER TABLE analysis_sections ADD COLUMN image_enabled INTEGER NOT NULL DEFAULT 1");
  }
  const fieldColumns = db.prepare("PRAGMA table_info(analysis_fields)").all() as Array<{ name: string }>;
  if (!fieldColumns.some((column) => column.name === "options_json")) {
    db.exec("ALTER TABLE analysis_fields ADD COLUMN options_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!fieldColumns.some((column) => column.name === "output_column")) {
    db.exec("ALTER TABLE analysis_fields ADD COLUMN output_column TEXT");
  }
  const fieldMigrations = [
    ["execution_type", "TEXT NOT NULL DEFAULT 'ai'"],
    ["export_enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["knowledge_base_id", "TEXT"],
    ["candidate_limit", "INTEGER NOT NULL DEFAULT 15"],
    ["match_field_key", "TEXT"],
    ["knowledge_column", "TEXT"],
    ["knowledge_sync_enabled", "INTEGER NOT NULL DEFAULT 0"],
    ["knowledge_capture_limit", "INTEGER NOT NULL DEFAULT 2"],
  ] as const;
  for (const [name, definition] of fieldMigrations) {
    if (!fieldColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE analysis_fields ADD COLUMN ${name} ${definition}`);
    }
  }
  const jobColumns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  for (const column of ["total_fields", "completed_fields", "failed_fields", "skipped_fields"]) {
    if (!jobColumns.some((item) => item.name === column)) db.exec(`ALTER TABLE jobs ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
  const jobControlColumns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!jobControlColumns.some((item) => item.name === "run_token")) db.exec("ALTER TABLE jobs ADD COLUMN run_token TEXT");
  if (!jobControlColumns.some((item) => item.name === "cancel_requested")) db.exec("ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0");
  const runColumns = db.prepare("PRAGMA table_info(analysis_field_runs)").all() as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "evidence_text")) {
    db.exec("ALTER TABLE analysis_field_runs ADD COLUMN evidence_text TEXT");
  }
  const jobColumnsLatest = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  for (const column of ["section_id", "section_name"]) {
    if (!jobColumnsLatest.some((item) => item.name === column)) db.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT`);
  }
  const modelColumns = db.prepare("PRAGMA table_info(model_configs)").all() as Array<{ name: string }>;
  if (!modelColumns.some((item) => item.name === "purpose")) db.exec("ALTER TABLE model_configs ADD COLUMN purpose TEXT NOT NULL DEFAULT 'vision'");
  if (!modelColumns.some((item) => item.name === "is_purpose_default")) db.exec("ALTER TABLE model_configs ADD COLUMN is_purpose_default INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE model_configs SET purpose = CASE WHEN supports_vision = 1 THEN 'vision' ELSE 'text' END WHERE purpose IS NULL OR purpose = ''");
  db.exec("UPDATE model_configs SET is_purpose_default = is_default WHERE is_purpose_default = 0 AND is_default = 1");
}
