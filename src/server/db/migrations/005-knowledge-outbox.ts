/** Triggers participate in the same transaction as every configuration writer. */
export function applyKnowledgeOutbox(db: any) {
  db.exec(`CREATE TABLE knowledge_sync_outbox (
    id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0,
    exported_revision INTEGER NOT NULL DEFAULT 0, scope TEXT,
    baseline_hash TEXT, pending_hash TEXT, last_error TEXT, exported_at TEXT
  ); INSERT INTO knowledge_sync_outbox(id) VALUES(1);`);
  for (const table of ["analysis_sections", "analysis_fields", "knowledge_bases", "knowledge_items"]) {
    for (const action of ["INSERT", "UPDATE", "DELETE"]) {
      db.exec(`CREATE TRIGGER sync_${table}_${action.toLowerCase()} AFTER ${action} ON ${table}
        BEGIN UPDATE knowledge_sync_outbox SET revision=revision+1 WHERE id=1; END;`);
    }
  }
}
