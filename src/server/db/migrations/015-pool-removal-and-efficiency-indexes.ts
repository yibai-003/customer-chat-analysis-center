export function applyPoolRemovalAndEfficiencyIndexes(db: any) {
  const columns = (db.prepare("PRAGMA table_info(model_configs)").all() as Array<{ name: string }>)
    .map((column) => column.name);
  if (!columns.includes("pool_removed_at")) db.exec("ALTER TABLE model_configs ADD COLUMN pool_removed_at TEXT");
  if (!columns.includes("pool_removed_reason")) db.exec("ALTER TABLE model_configs ADD COLUMN pool_removed_reason TEXT");
  if (!columns.includes("pool_removed_note")) db.exec("ALTER TABLE model_configs ADD COLUMN pool_removed_note TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_field_runs_created_at ON analysis_field_runs(created_at);
    CREATE INDEX IF NOT EXISTS idx_field_runs_record_id ON analysis_field_runs(record_id);
    CREATE INDEX IF NOT EXISTS idx_field_runs_field_created ON analysis_field_runs(field_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_model_usage_events_field_created ON model_usage_events(field_id, created_at);
  `);
}
