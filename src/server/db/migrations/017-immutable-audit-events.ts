/**
 * Audit events are append-only evidence. SQLite cannot drop a column constraint
 * in place, so the actor reference is rebuilt without a foreign key: actor ids are
 * historical values that must survive account removal. UPDATE/DELETE are rejected
 * by triggers to keep the log immutable at the storage layer.
 */
export function applyImmutableAuditEvents(db: any) {
  db.exec(`
    CREATE TABLE audit_events_rebuild (
      id TEXT PRIMARY KEY,
      organization_id TEXT REFERENCES organizations(id),
      actor_user_id TEXT,
      actor_display TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      outcome TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      correlation_id TEXT,
      occurred_at TEXT NOT NULL
    );
    INSERT INTO audit_events_rebuild
      SELECT id, organization_id, actor_user_id, actor_display, action, target_type, target_id, outcome, metadata_json, correlation_id, occurred_at
      FROM audit_events;
    DROP TABLE audit_events;
    ALTER TABLE audit_events_rebuild RENAME TO audit_events;
    CREATE INDEX IF NOT EXISTS idx_audit_events_org_time ON audit_events(organization_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_user_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_audit_events_action_time ON audit_events(action, occurred_at);
    CREATE TRIGGER IF NOT EXISTS audit_events_immutable_update
      BEFORE UPDATE ON audit_events
      BEGIN SELECT RAISE(ABORT, '审计事件不可修改'); END;
    CREATE TRIGGER IF NOT EXISTS audit_events_immutable_delete
      BEFORE DELETE ON audit_events
      BEGIN SELECT RAISE(ABORT, '审计事件不可删除'); END;
  `);
}