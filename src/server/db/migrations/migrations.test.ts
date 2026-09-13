import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appliedMigrations, migrations, runMigrations } from "./index";
import { applyLegacyBaseline } from "./002-legacy-baseline";

let dir: string;
let db: any;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-migrations-")); db = new Database(path.join(dir, "app.db")); });
afterEach(() => { if (db.open) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
describe("versioned migrations", () => {
  it("upgrades a legacy version-1 schema without resetting configuration and stays idempotent", () => {
    applyLegacyBaseline(db);
    db.prepare("INSERT INTO schema_migrations VALUES(1,'legacy','2026-01-01')").run();
    db.exec("INSERT INTO analysis_sections(id,name,prompt,output_schema_json,created_at,updated_at) VALUES('custom','name','keep my prompt','[]','before','before')");
    runMigrations(db);
    expect(appliedMigrations(db).map(m => m.version)).toEqual([1,2,3]);
    expect(db.prepare("SELECT prompt FROM analysis_sections").get().prompt).toBe("keep my prompt");
    const columns = db.prepare("PRAGMA table_info(jobs)").all().map((c: any) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["run_started_at", "heartbeat_at", "run_finished_at"]));
    const before = JSON.stringify(appliedMigrations(db));
    runMigrations(db);
    expect(JSON.stringify(appliedMigrations(db))).toBe(before);
    expect(fs.readdirSync(path.join(dir, "backups/migrations"))).toHaveLength(1);
  });
  it("rolls back all pending schema changes and version stamps on failure", () => {
    db.exec("CREATE TABLE original(value TEXT); INSERT INTO original VALUES('preserve');");
    expect(() => runMigrations(db, [...migrations, { version: 4, name: "broken", up: (d) => { d.exec("CREATE TABLE partial(id INTEGER)"); throw new Error("injected failure"); } }])).toThrow("injected failure");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get()).toBeUndefined();
    expect(appliedMigrations(db)).toEqual([]);
    expect(db.prepare("SELECT value FROM original").get().value).toBe("preserve");
    const file = fs.readdirSync(path.join(dir, "backups/migrations"))[0];
    const backup = new Database(path.join(dir, "backups/migrations", file), { readonly: true });
    expect(backup.pragma("integrity_check", { simple: true })).toBe("ok"); backup.close();
  });
  it("rejects a newer schema before making changes", () => {
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT); INSERT INTO schema_migrations VALUES(99,'future','now')");
    expect(() => runMigrations(db)).toThrow("高于当前代码");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='jobs'").get()).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "backups"))).toBe(false);
  });
  it("read-only diagnostic commands neither create missing databases nor migrate old ones", async () => {
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT); INSERT INTO schema_migrations VALUES(1,'legacy','old')");
    db.close();
    const file = path.join(dir, "app.db");
    const before = fs.readFileSync(file);
    const exec = promisify(execFile);
    await exec(process.execPath, ["--import", "tsx", "src/server/db-migration-cli.ts"], { cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: file }, windowsHide: true });
    expect(fs.readFileSync(file)).toEqual(before);
    for (const command of ["db-check-cli.ts", "db-migration-cli.ts"]) {
      const missing = path.join(dir, "missing.db");
      await expect(exec(process.execPath, ["--import", "tsx", `src/server/${command}`], { cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: missing }, windowsHide: true })).rejects.toThrow();
      expect(fs.existsSync(missing)).toBe(false);
    }
  });
});
