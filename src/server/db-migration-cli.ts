import Database from "better-sqlite3";
import { config } from "./config";
import { appliedMigrations, currentSchemaVersion } from "./db/migrations";
const db = new Database(config.databasePath, { readonly: true, fileMustExist: true });
try {
  const migrations = appliedMigrations(db);
  console.log(JSON.stringify({ currentVersion: migrations.at(-1)?.version ?? 0, supportedVersion: currentSchemaVersion, migrations }, null, 2));
} finally { db.close(); }
