import { db, initDb } from "./db/client";
import { config } from "./config";
import { appliedMigrations, currentSchemaVersion } from "./db/migrations";

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
}, null, 2));
db.close();