import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, initDb } from "../db/client";
import { addRecords, createJob, getRecord, listRecords, updateRecord } from "../db/repositories";
import { captureCatalog } from "./knowledge/knowledge-sync-service";
import { createFullBackup, restoreFullBackup, verifyBackup } from "./backup-service";

let root: string;
let recordId: string;
let jobId: string;
let workbookPath: string;
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
beforeEach(async () => {
  initDb();
  db.exec("DELETE FROM records; DELETE FROM import_jobs; DELETE FROM jobs; DELETE FROM knowledge_imports;");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "full-backup-test-"));
  workbookPath = path.join(root, "source.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1"); sheet.addRow(["来源", "截图"]); sheet.addRow(["测试", ""]);
  sheet.addImage(workbook.addImage({ buffer: pixel as any, extension: "png" }), "B2:B2");
  await workbook.xlsx.writeFile(workbookPath);
  fs.writeFileSync(path.join(root, "screenshot.png"), pixel);
  const job = createJob("source.xlsx", workbookPath, { id: "refund", name: "refund" }); jobId = job.id;
  addRecords(job.id, [{ rowNumber: 2, sheetName: "Sheet1", anchor: {}, sourceFields: { origin: "test" }, imagePath: path.join(root, "screenshot.png") }]);
  recordId = listRecords(job.id)[0].id;
  updateRecord(recordId, { sectionId: "refund", humanResult: { reason: "verified" }, reviewNote: "review note", status: "completed", reviewStatus: "confirmed" });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const backup = (retention = 7) => createFullBackup({ database: db, backupRoot: path.join(root, "backups"), catalog: captureCatalog, retention });

describe("verified full backups", () => {
  it("restores workbook images, review values, configuration and paths in a new directory", async () => {
    const result = await backup();
    const manifest = await verifyBackup(result.directory);
    expect(manifest.references).toHaveLength(2);
    const target = path.join(root, "new-environment");
    await restoreFullBackup(result.directory, target);
    const restored = new Database(path.join(target, "data/app.db"));
    try {
      const image = restored.prepare("SELECT image_path FROM records WHERE id=?").get(recordId).image_path;
      expect(image.startsWith(target)).toBe(true);
      expect(fs.readFileSync(image)).toEqual(pixel);
      const review = restored.prepare("SELECT * FROM record_section_reviews WHERE record_id=?").get(recordId);
      expect(JSON.parse(review.human_result_json)).toEqual({ reason: "verified" });
      expect(review.review_note).toBe("review note");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(restored.prepare("SELECT source_path FROM jobs WHERE id=?").get(jobId).source_path);
      expect(workbook.worksheets[0].getImages()).toHaveLength(1);
      const script = 'import { exportJob } from "./src/server/services/excel-export-service.ts"; console.log(await exportJob(process.argv[1], ["refund"]));';
      const execution = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, jobId], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: path.join(target, "data/app.db"), DATA_DIR: path.join(target, "data") }, windowsHide: true,
      });
      const output = execution.stdout.trim();
      const exported = new ExcelJS.Workbook(); await exported.xlsx.readFile(output);
      const headers = exported.worksheets[0].getRow(1).values as unknown[];
      const reasonColumn = headers.findIndex(v => v === "截图解析");
      expect(reasonColumn).toBeGreaterThan(0);
      expect(exported.worksheets[0].getRow(2).getCell(reasonColumn).value).toBe("verified");
      expect(exported.worksheets[0].getImages()).toHaveLength(1);
      expect(captureCatalog(restored)).toEqual(captureCatalog(db));
    } finally { restored.close(); }
    expect(getRecord(recordId)?.imagePath).toBe(path.join(root, "screenshot.png"));
  });

  it("keeps old backups and source files when a required file is missing", async () => {
    const good = await backup(1);
    await fsp.unlink(workbookPath);
    await expect(backup(1)).rejects.toThrow();
    expect((await verifyBackup(good.directory)).files.length).toBeGreaterThan(2);
    expect(fs.readdirSync(path.join(root, "backups")).some(n => n.startsWith(".partial"))).toBe(false);
  });

  it("rejects corrupted files and traversal before creating the recovery destination", async () => {
    const good = await backup();
    fs.appendFileSync(path.join(good.directory, "knowledge/catalog.json"), "corrupt");
    const target = path.join(root, "recovery");
    await expect(restoreFullBackup(good.directory, target)).rejects.toThrow("checksum");
    expect(fs.existsSync(target)).toBe(false);
    const manifestPath = path.join(good.directory, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.files[0].path = "../outside.db";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(verifyBackup(good.directory)).rejects.toThrow();
  });

  it("prunes only verified full packages, preserves legacy/protected files and refuses overwrites", async () => {
    const good = await backup(1);
    const legacy = path.join(root, "backups/manual-old.db"); fs.writeFileSync(legacy, "protected");
    await new Promise(resolve => setTimeout(resolve, 5));
    const next = await backup(1);
    expect(fs.existsSync(good.directory)).toBe(false);
    expect(fs.readFileSync(legacy, "utf8")).toBe("protected");
    await expect(restoreFullBackup(next.directory, root)).rejects.toThrow("already exists");
  });

  it.each([0, -1, NaN, Infinity, 1.5])("rejects invalid retention %s before touching old backups", async retention => {
    await expect(backup(retention)).rejects.toThrow("BACKUP_RETENTION");
    expect(fs.existsSync(path.join(root, "backups"))).toBe(false);
  });

  it("refuses overlapping creators without deleting the existing operation lock", async () => {
    fs.mkdirSync(path.join(root, "backups"));
    fs.writeFileSync(path.join(root, "backups/.backup.lock"), "existing operation");
    await expect(backup()).rejects.toThrow();
    expect(fs.readFileSync(path.join(root, "backups/.backup.lock"), "utf8")).toBe("existing operation");
  });
});
