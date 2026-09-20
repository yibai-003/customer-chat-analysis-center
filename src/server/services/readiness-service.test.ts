import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { currentSchemaVersion, migrations } from "../db/migrations";
import { getReadinessStatus, isDatabaseReady } from "./readiness-service";

const checks = {
  vision: { verified: true },
  text: { verified: true },
};

describe("readiness service", () => {
  it("is ready only when disk and both model purposes are ready", () => {
    expect(getReadinessStatus({
      dataDir: "C:/data",
      minFreeDiskMb: 512,
      statfs: () => ({ bavail: 2048, bsize: 1024 * 1024 }),
      databaseCheck: () => true,
      modelChecks: () => checks as never,
      modelActions: () => ({ verifyPoolMemberIds: [] }) as never,
    })).toMatchObject({
      ready: true,
      database: true,
      freeDiskMb: 2048,
      models: { vision: true, text: true },
    });
  });

  it("reports an actionable non-ready result", () => {
    const result = getReadinessStatus({
      dataDir: "C:/data",
      minFreeDiskMb: 512,
      statfs: () => ({ bavail: 100, bsize: 1024 * 1024 }),
      databaseCheck: () => true,
      modelChecks: () => ({ ...checks, text: { verified: false } }) as never,
      modelActions: () => ({ verifyPoolMemberIds: ["text-model"] }) as never,
    });

    expect(result.ready).toBe(false);
    expect(result.models).toEqual({ vision: true, text: false });
    expect(result.actions).toEqual({ verifyPoolMemberIds: ["text-model"] });
  });

  it("is not ready when the database is missing or not at the supported schema", () => {
    const result = getReadinessStatus({
      dataDir: "C:/data",
      minFreeDiskMb: 512,
      statfs: () => ({ bavail: 2048, bsize: 1024 * 1024 }),
      databaseCheck: () => false,
      modelChecks: () => checks as never,
      modelActions: () => ({ verifyPoolMemberIds: [] }) as never,
    });

    expect(result).toMatchObject({
      ready: false,
      database: false,
      models: { vision: true, text: true },
    });
  });

  it("accepts an intact database at the supported schema and rejects missing tables", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-db-"));
    const databasePath = path.join(root, "app.db");
    const database = new Database(databasePath);
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE analysis_sections (id TEXT PRIMARY KEY);
      CREATE TABLE analysis_fields (id TEXT PRIMARY KEY);
      CREATE TABLE knowledge_bases (id TEXT PRIMARY KEY);
      CREATE TABLE knowledge_items (id TEXT PRIMARY KEY);
    `);
    const insertMigration = database.prepare(
      "INSERT INTO schema_migrations VALUES (?, ?, 'now')",
    );
    for (const migration of migrations) {
      insertMigration.run(migration.version, migration.name);
    }
    database.close();

    try {
      expect(isDatabaseReady(databasePath)).toBe(true);
      const incomplete = new Database(databasePath);
      incomplete.prepare("DELETE FROM schema_migrations WHERE version = ?").run(currentSchemaVersion - 1);
      incomplete.close();
      expect(isDatabaseReady(databasePath)).toBe(false);

      const wrongName = new Database(databasePath);
      wrongName.prepare(
        "INSERT INTO schema_migrations VALUES (?, 'wrong-name', 'now')",
      ).run(currentSchemaVersion - 1);
      wrongName.close();
      expect(isDatabaseReady(databasePath)).toBe(false);

      const missingTable = new Database(databasePath);
      missingTable.prepare("DELETE FROM schema_migrations WHERE version = ?").run(currentSchemaVersion - 1);
      missingTable.exec("DROP TABLE analysis_fields");
      missingTable.close();
      expect(isDatabaseReady(databasePath)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
