import { runMigrations } from "./migrations";
import { seedNewDatabase } from "./seed";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config";

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
export const db = new Database(config.databasePath);
db.pragma("foreign_keys = ON");

export function initDb(_options: { preserveConfiguration?: boolean } = {}) {
  runMigrations(db);
  if (db.prepare("SELECT COUNT(*) count FROM analysis_sections").get().count === 0) {
    db.transaction(() => seedNewDatabase(db))();
  }
}
