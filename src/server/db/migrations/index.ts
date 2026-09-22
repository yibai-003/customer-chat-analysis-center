import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { applyLegacyBaseline } from "./002-legacy-baseline";
import { applyRunLifecycle } from "./003-run-lifecycle";
import { applyModelCapabilities } from "./004-model-capabilities";
import { applyKnowledgeOutbox } from "./005-knowledge-outbox";
import { applyLostDealAnalysis } from "./006-lost-deal-analysis";
import { applyLostDealKnowledgeMetadata } from "./007-lost-deal-knowledge-metadata";
import { applyLostDealCapture } from "./008-lost-deal-capture";
import { applyReceptionQualityNormalization } from "./009-reception-quality-normalization";
import { applyUnifiedReceptionQuality } from "./010-unified-reception-quality";
import { applyOptimizedReceptionQualityPrompts } from "./011-optimized-reception-quality-prompts";
import { applyFusedReceptionQualityPrompts } from "./012-fused-reception-quality-prompts";
import { applyReceptionExcelSchema } from "./013-reception-excel-schema";
import { applyModelPools } from "./014-model-pools";
import { applyPoolRemovalAndEfficiencyIndexes } from "./015-pool-removal-and-efficiency-indexes";
import { applyIdentityAndSessions } from "./016-identity-and-sessions";
import { applyImmutableAuditEvents } from "./017-immutable-audit-events";
import { applySectionConfigVersions } from "./018-section-config-versions";
import { applySectionVersionIntegrity } from "./019-section-version-integrity";
import { applyPlatformDictionaryAndTaskBinding } from "./020-platform-dictionary-task-binding";
import { applyGlobalConversationId } from "./021-global-conversation-id";
import { applyReceptionImportContract } from "./022-reception-import-contract";
import { applyReceptionTwoStageAnalysis } from "./023-reception-two-stage-analysis";

export interface Migration { version: number; name: string; up: (db: any) => void }
export const migrations: Migration[] = [
  { version: 2, name: "legacy-baseline", up: applyLegacyBaseline },
  { version: 3, name: "run-lifecycle", up: applyRunLifecycle },
  { version: 4, name: "model-capabilities", up: applyModelCapabilities },
  { version: 5, name: "knowledge-outbox", up: applyKnowledgeOutbox },
  { version: 6, name: "lost-deal-analysis", up: applyLostDealAnalysis },
  { version: 7, name: "lost-deal-knowledge-metadata", up: applyLostDealKnowledgeMetadata },
  { version: 8, name: "lost-deal-capture", up: applyLostDealCapture },
  { version: 9, name: "reception-quality-normalization", up: applyReceptionQualityNormalization },
  { version: 10, name: "unified-reception-quality", up: applyUnifiedReceptionQuality },
  { version: 11, name: "optimized-reception-quality-prompts", up: applyOptimizedReceptionQualityPrompts },
  { version: 12, name: "fused-reception-quality-prompts", up: applyFusedReceptionQualityPrompts },
  { version: 13, name: "reception-excel-schema", up: applyReceptionExcelSchema },
  { version: 14, name: "model-pools", up: applyModelPools },
  { version: 15, name: "pool-removal-and-efficiency-indexes", up: applyPoolRemovalAndEfficiencyIndexes },
  { version: 16, name: "identity-and-sessions", up: applyIdentityAndSessions },
  { version: 17, name: "immutable-audit-events", up: applyImmutableAuditEvents },
  { version: 18, name: "section-config-versions", up: applySectionConfigVersions },
  { version: 19, name: "section-version-integrity", up: applySectionVersionIntegrity },
  { version: 20, name: "platform-dictionary-task-binding", up: applyPlatformDictionaryAndTaskBinding },
  { version: 21, name: "global-conversation-id", up: applyGlobalConversationId },
  { version: 22, name: "reception-import-contract", up: applyReceptionImportContract },
  { version: 23, name: "reception-two-stage-analysis", up: applyReceptionTwoStageAnalysis },
];
export const currentSchemaVersion = 23;
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
  // Version 19 rebuilds a referenced parent table. SQLite requires foreign-key
  // enforcement to be disabled before the transaction; final validation still
  // occurs before commit so the complete pending set remains atomic.
  const rebuildsReferencedTable = pending.some((step) => step.version === 19);
  if (rebuildsReferencedTable) db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");
      for (const step of pending) {
        step.up(db);
        db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(step.version, step.name, new Date().toISOString());
      }
      if (rebuildsReferencedTable) {
        const violations = db.pragma("foreign_key_check") as unknown[];
        if (violations.length) throw new Error(`迁移后外键校验失败：${JSON.stringify(violations.slice(0, 20))}`);
      }
    })();
  } finally {
    if (rebuildsReferencedTable) db.pragma("foreign_keys = ON");
  }
}
