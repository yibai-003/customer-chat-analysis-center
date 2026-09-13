export function applyModelCapabilities(db: any) {
  const columns = new Set((db.prepare("PRAGMA table_info(model_configs)").all() as { name: string }[]).map(c => c.name));
  if (!columns.has("capability_json")) db.exec("ALTER TABLE model_configs ADD COLUMN capability_json TEXT");
  if (!columns.has("capability_checked_at")) db.exec("ALTER TABLE model_configs ADD COLUMN capability_checked_at INTEGER");
}
