import { db, initDb } from "./db/client";
import { config } from "./config";
import { appliedMigrations, currentSchemaVersion } from "./db/migrations";
import { lastSectionConfigV1MigrationReport } from "./db/migrations/018-section-config-versions";

initDb();
const version = appliedMigrations(db).at(-1)?.version ?? 0;
if (version !== currentSchemaVersion) {
  throw new Error(`数据库迁移版本不匹配：${version} != ${currentSchemaVersion}`);
}
const existingV1Count = (db.prepare(`
  SELECT COUNT(*) AS count FROM analysis_section_versions WHERE version_number = 1
`).get() as { count: number }).count;
const sectionConfigV1Migration = lastSectionConfigV1MigrationReport.succeeded
  || lastSectionConfigV1MigrationReport.skipped
  || lastSectionConfigV1MigrationReport.errors.length
  ? lastSectionConfigV1MigrationReport
  : { succeeded: 0, skipped: existingV1Count, errors: [] };
console.log(JSON.stringify({
  database: config.databasePath,
  initialized: true,
  version,
  supportedVersion: currentSchemaVersion,
  sectionConfigV1Migration,
}, null, 2));
db.close();
