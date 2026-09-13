import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { applyLegacyBaseline } from "./002-legacy-baseline";
import { applyRunLifecycle } from "./003-run-lifecycle";

export interface Migration { version: number; name: string; up: (db: any) => void }
export const migrations: Migration[] = [
  { version: 2, name: "legacy-baseline", up: applyLegacyBaseline },
  { version: 3, name: "run-lifecycle", up: applyRunLifecycle },
];
export const currentSchemaVersion = 3;
export function appliedMigrations(db: any): { version: number; name: string; applied_at: string }[] {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()) return [];
  return db.prepare("SELECT version,name,applied_at FROM schema_migrations ORDER BY version").all();
}
export function runMigrations(db: any, steps: Migration[] = migrations) {
  const applied = appliedMigrations(db);
  const max = Math.max(...steps.map(s => s.version));
  if (applied.some(m => m.version > max)) throw new Error("数据库版本高于当前代码，请升级程序，禁止降级写入");
  if (applied.some(m => m.version !== 1 && !steps.some(s => s.version === m.version && s.name === m.name))) {
    throw new Error("数据库迁移记录与当前版本不匹配，请检查升级历史");
  }
  const pending = steps.filter(s => !applied.some(m => m.version === s.version));
  if (!pending.length) return;
  // Existing version 1 did not certify the actual schema. Version 2 repairs columns once.
  const hasData = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
  if (hasData && db.name !== ":memory:") {
    const dir = path.join(path.dirname(db.name), "backups", "migrations");
    fs.mkdirSync(dir, { recursive: true });
    const backup = path.join(dir, `before-v${max}-${Date.now()}-${crypto.randomUUID()}.db`);
    db.prepare("VACUUM INTO ?").run(backup);
    const check = new Database(backup, { readonly: true });
    try { if (check.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("迁移前备份校验失败"); }
    finally { check.close(); }
  }
  // Apply all pending steps atomically: no partial schema or premature version stamp.
  db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");
    for (const step of pending) {
      step.up(db);
      db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(step.version, step.name, new Date().toISOString());
    }
  })();
}
