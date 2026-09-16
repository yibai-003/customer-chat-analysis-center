export function applyLostDealCapture(db: any) {
  db.exec(`
    CREATE TABLE lost_deal_record_reasons (
      record_id TEXT NOT NULL,
      field_id TEXT NOT NULL,
      knowledge_item_id TEXT NOT NULL,
      reason_type TEXT NOT NULL CHECK(reason_type IN ('customer','service')),
      reason_name TEXT NOT NULL,
      evidence TEXT NOT NULL,
      PRIMARY KEY(record_id, field_id, knowledge_item_id),
      FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE,
      FOREIGN KEY(field_id) REFERENCES analysis_fields(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_lost_deal_reasons_item ON lost_deal_record_reasons(knowledge_item_id);
    UPDATE analysis_fields
    SET knowledge_sync_enabled = 1
    WHERE section_id = 'lost-deal' AND key = '未成交归因'
      AND execution_type = 'lost_deal_attribution';
  `);
}
