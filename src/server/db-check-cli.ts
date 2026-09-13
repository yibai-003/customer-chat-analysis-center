import Database from "better-sqlite3";
import { config } from "./config";
import { appliedMigrations, currentSchemaVersion } from "./db/migrations";
const db = new Database(config.databasePath, { readonly: true, fileMustExist: true });
try {
  const integrity = db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") throw new Error("Database integrity check failed");
  const foreignKeys = db.pragma("foreign_key_check");
  if (foreignKeys.length) throw new Error("Database foreign key check failed");
  const version = appliedMigrations(db).at(-1)?.version ?? 0;
  const counts = Object.fromEntries(["analysis_sections", "analysis_fields", "knowledge_bases", "knowledge_items"].map(table => [table, db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
  console.log(JSON.stringify({ integrity, foreignKeys: 0, version, supportedVersion: currentSchemaVersion, ...counts }, null, 2));
} finally { db.close(); }
