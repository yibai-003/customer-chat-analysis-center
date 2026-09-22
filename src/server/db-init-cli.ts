import { db, initDb } from "./db/client";
import { config } from "./config";
import { appliedMigrations, currentSchemaVersion } from "./db/migrations";
import { lastSectionConfigV1MigrationReport } from "./db/migrations/018-section-config-versions";

initDb();
const version = appliedMigrations(db).at(-1)?.version ?? 0;
if (version !== currentSchemaVersion) {
  throw new Error(`数据库迁移版本不匹配：${version} != ${currentSchemaVersion}`);
}
console.log(JSON.stringify({
  database: config.databasePath,
  initialized: true,
  version,
  supportedVersion: currentSchemaVersion,
  sectionConfigV1Migration: lastSectionConfigV1MigrationReport,
}, null, 2));
db.close();
