export function applyGlobalConversationId(db: any) {
  const columns = db.prepare("PRAGMA table_info(records)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "conversation_id")) {
    db.exec("ALTER TABLE records ADD COLUMN conversation_id TEXT");
  }
  if (!columns.some((column) => column.name === "conversation_id_assigned_at")) {
    db.exec("ALTER TABLE records ADD COLUMN conversation_id_assigned_at TEXT");
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_records_conversation_id
      ON records(conversation_id)
      WHERE conversation_id IS NOT NULL
  `);
}
