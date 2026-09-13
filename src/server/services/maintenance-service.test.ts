import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrations";
import { acquireInstanceLock } from "../instance-lock";
import { maintainFiles } from "./maintenance-service";

let root: string;
let database: any;
let options: { databasePath: string; dataDir: string; projectRoot: string };
function file(relative: string, old = true) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, relative);
  if (old) fs.utimesSync(target, new Date(0), new Date(0));
  return target;
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-maintenance-"));
  options = { databasePath: path.join(root, "app.db"), dataDir: root, projectRoot: root };
  database = new Database(options.databasePath); runMigrations(database);
});
afterEach(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
function job(source: string, status = "completed") {
  database.prepare("INSERT INTO jobs(id,original_filename,source_path,status,created_at,updated_at) VALUES('job','test',?,?, 'now','now')").run(source, status);
}

describe("offline reference-aware maintenance", () => {
  it("previews by default and preserves all four kinds of persisted references on apply", async () => {
    const source = file("uploads/source.xlsx"); job(source);
    const image = file("job-staging/old/image.png");
    database.prepare("INSERT INTO records(id,job_id,sheet_name,row_number,anchor_json,source_fields_json,image_path,status,review_status,created_at,updated_at) VALUES('r','job','s',1,'{}','{}',?,'completed','pending','now','now')").run(image);
    const imported = file("uploads/import.xlsx");
    database.prepare("INSERT INTO import_jobs(id,filename,source_path,status,created_at,updated_at) VALUES('i','i',?,'completed','now','now')").run(imported);
    database.exec("INSERT INTO analysis_sections(id,name,prompt,output_schema_json,created_at,updated_at) VALUES('s','s','','{}','now','now'); INSERT INTO knowledge_bases(id,section_id,name,original_filename,column_schema_json,created_at,updated_at) VALUES('k','s','k','k','[]','now','now');");
    const knowledge = file("knowledge-previews/knowledge.xlsx");
    database.prepare("INSERT INTO knowledge_imports(id,knowledge_base_id,original_filename,source_path,sheet_name,summary_json,status,created_at) VALUES('ki','k','k',?,'s','{}','completed','now')").run(path.relative(root, knowledge));
    const abandoned = file("uploads/abandoned.xlsx");
    const recent = file("job-staging/old/recent.png", false);
    fs.utimesSync(path.dirname(recent), new Date(0), new Date(0));
    const original = fs.readFileSync(options.databasePath);
    const preview = await maintainFiles(options);
    expect(preview).toMatchObject({ mode: "dry-run", removed: 0, skipped: { referenced: 4, recent: 1 } });
    expect(preview.candidates).toHaveLength(1); expect(fs.existsSync(abandoned)).toBe(true);
    const applied = await maintainFiles({ ...options, apply: true });
    expect(applied.removed).toBe(1); expect(fs.existsSync(abandoned)).toBe(false);
    for (const protectedFile of [source, image, imported, knowledge, recent]) expect(fs.existsSync(protectedFile)).toBe(true);
    expect(fs.readFileSync(options.databasePath)).toEqual(original);
  });
  it("does not follow junctions or remove hard links, logs, exports, backups or durable sources", async () => {
    const outside = file("outside/protected.xlsx");
    fs.mkdirSync(path.join(root, "uploads"));
    fs.symlinkSync(path.join(root, "outside"), path.join(root, "uploads/link"), "junction");
    fs.linkSync(outside, path.join(root, "uploads/hardlink.xlsx"));
    const durable = ["logs/server.out.log", "exports/result.xlsx", "jobs/image.png", "imports/input.xlsx", "knowledge-imports/k.xlsx", "backups/full/backup.db"].map(name => file(name));
    expect((await maintainFiles({ ...options, apply: true })).removed).toBe(0);
    for (const protectedFile of [outside, ...durable]) expect(fs.existsSync(protectedFile)).toBe(true);
    fs.unlinkSync(path.join(root, "uploads/link"));
  });
  it("refuses a linked cleanup root before deletion", async () => {
    const outside = file("outside/preserved.xlsx");
    fs.symlinkSync(path.dirname(outside), path.join(root, "uploads"), "junction");
    await expect(maintainFiles({ ...options, apply: true })).rejects.toThrow("联接");
    expect(fs.existsSync(outside)).toBe(true);
    fs.unlinkSync(path.join(root, "uploads"));
  });
  it("rejects application while the server owns the database", async () => {
    const abandoned = file("uploads/abandoned.xlsx");
    const lock = await acquireInstanceLock(options.databasePath);
    try {
      expect((await maintainFiles(options)).mode).toBe("dry-run");
      await expect(maintainFiles({ ...options, apply: true })).rejects.toThrow("已有服务");
      expect(fs.existsSync(abandoned)).toBe(true);
    } finally { await lock.release(); }
  });
  it.each(["job", "import", "knowledge"])("preserves files when %s work is unfinished", async kind => {
    const pending = file("uploads/pending.xlsx");
    if (kind === "job") job(pending, "processing");
    else if (kind === "import") database.prepare("INSERT INTO import_jobs(id,filename,source_path,status,created_at,updated_at) VALUES('i','i',?,'queued','now','now')").run(pending);
    else {
      database.exec("INSERT INTO analysis_sections(id,name,prompt,output_schema_json,created_at,updated_at) VALUES('s','s','','{}','now','now'); INSERT INTO knowledge_bases(id,section_id,name,original_filename,column_schema_json,created_at,updated_at) VALUES('k','s','k','k','[]','now','now');");
      database.prepare("INSERT INTO knowledge_imports(id,knowledge_base_id,original_filename,source_path,sheet_name,summary_json,status,created_at) VALUES('ki','k','k',?,'s','{}','processing','now')").run(pending);
    }
    await expect(maintainFiles({ ...options, apply: true })).rejects.toThrow("未恢复");
    expect(fs.existsSync(pending)).toBe(true);
  });
  it.each([0, -1, NaN, Infinity, 1.5])("rejects invalid retention %s without deleting files", async days => {
    const target = file("uploads/old.xlsx");
    await expect(maintainFiles({ ...options, days, apply: true })).rejects.toThrow("CLEANUP_RETENTION_DAYS");
    expect(fs.existsSync(target)).toBe(true);
  });
  it("does not create missing databases or migrate old ones", async () => {
    await expect(maintainFiles({ ...options, databasePath: path.join(root, "missing/app.db") })).rejects.toThrow("不存在");
    expect(fs.existsSync(path.join(root, "missing"))).toBe(false);
    database.exec("DELETE FROM schema_migrations WHERE version=4");
    const before = fs.readFileSync(options.databasePath);
    await expect(maintainFiles(options)).rejects.toThrow("版本");
    expect(fs.readFileSync(options.databasePath)).toEqual(before);
  });
  it("protects the database and SQLite sidecars even when configured inside uploads", async () => {
    const target = path.join(root, "uploads/nested.db");
    fs.mkdirSync(path.dirname(target)); database.close();
    fs.copyFileSync(options.databasePath, target);
    database = new Database(options.databasePath);
    fs.utimesSync(target, new Date(0), new Date(0));
    const sidecar = file("uploads/nested.db-shm");
    expect((await maintainFiles({ ...options, databasePath: target, apply: true })).removed).toBe(0);
    expect(fs.existsSync(target)).toBe(true); expect(fs.existsSync(sidecar)).toBe(true);
  });
});
