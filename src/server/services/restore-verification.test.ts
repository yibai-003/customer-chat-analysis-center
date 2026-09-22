import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, initDb } from "../db/client";
import { addRecords, createJob, listRecords } from "../db/repositories";
import { captureCatalog } from "./knowledge/knowledge-sync-service";
import { createFullBackup, restoreFullBackup } from "./backup-service";
import { verifyRestoredEnvironment } from "./restore-verification";

let root: string;
let imagePath: string;
let recordId: string;

async function restoredEnvironment() {
  const backup = await createFullBackup({
    database: db,
    backupRoot: path.join(root, "backups"),
    catalog: captureCatalog,
  });
  const target = path.join(root, `restored-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await restoreFullBackup(backup.directory, target);
  return target;
}

beforeEach(() => {
  initDb();
  db.exec("DELETE FROM model_usage_events; DELETE FROM model_configs; DELETE FROM records; DELETE FROM import_jobs; DELETE FROM jobs;");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "restore-verify-test-"));
  imagePath = path.join(root, "image.png");
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const job = createJob("verify.xlsx", imagePath, { id: "refund", name: "退货分析" });
  addRecords(job.id, [{ sheetName: "Sheet1", rowNumber: 1, anchor: {}, sourceFields: { 客服: "验证" }, imagePath }]);
  recordId = listRecords(job.id)[0]!.id;
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("restored environment verification", () => {
  it("passes every check for a freshly restored environment", async () => {
    const target = await restoredEnvironment();

    const result = verifyRestoredEnvironment(target);

    expect(result.ok, JSON.stringify(result.checks)).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual([
      "restored-marker",
      "database",
      "file-references",
      "knowledge-catalog",
      "model-credentials",
    ]);
    expect(result.checks.find((check) => check.name === "database")!.detail).toMatchObject({ version: 20 });
    expect(result.checks.find((check) => check.name === "file-references")!.detail).toMatchObject({ checked: 2 });
    expect(result.checks.find((check) => check.name === "model-credentials")!.detail).toMatchObject({ models: 0, decryptable: true });
  });

  it("fails closed when referenced files are missing or the knowledge hash diverges", async () => {
    const target = await restoredEnvironment();
    const restored = new Database(path.join(target, "data/app.db"), { readonly: true });
    let restoredImage: string;
    try {
      restoredImage = (restored.prepare("SELECT image_path FROM records WHERE id = ?").get(recordId) as { image_path: string }).image_path;
    } finally {
      restored.close();
    }
    fs.rmSync(restoredImage);
    fs.writeFileSync(path.join(target, "data/knowledge-sync-state.json"), JSON.stringify({ hash: "0".repeat(64) }));

    const result = verifyRestoredEnvironment(target);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name === "file-references")).toMatchObject({ ok: false });
    expect(result.checks.find((check) => check.name === "knowledge-catalog")).toMatchObject({ ok: false });
    expect(result.checks.find((check) => check.name === "database")).toMatchObject({ ok: true });
  });

  it("refuses directories that are not independent restore copies", async () => {
    const target = await restoredEnvironment();
    fs.rmSync(path.join(target, "RESTORED.json"));

    const result = verifyRestoredEnvironment(target);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name === "restored-marker")).toMatchObject({ ok: false });
  });
});
