export function applyRunLifecycle(db: any) {
  const columns = new Set((db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map(c => c.name));
  for (const name of ["run_started_at", "heartbeat_at", "run_finished_at"]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${name} INTEGER`);
  }
}
