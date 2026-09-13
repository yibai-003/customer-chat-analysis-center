import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { config } from "./config";
import { createFullBackup, positiveInteger } from "./services/backup-service";

try {
  const retention = positiveInteger(process.env.BACKUP_RETENTION, "BACKUP_RETENTION", 7);
  if (!fs.existsSync(config.databasePath)) throw new Error("Database does not exist");
  const database = new Database(config.databasePath, { readonly: true, fileMustExist: true });
  try {
    const { captureCatalog } = await import("./services/knowledge/knowledge-sync-service");
    console.log(JSON.stringify(await createFullBackup({ database, backupRoot: path.join(config.dataDir, "backups"), retention, catalog: captureCatalog }), null, 2));
  } finally { database.close(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Backup failed");
  process.exitCode = 1;
}
