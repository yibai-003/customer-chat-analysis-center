import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { db, initDb } from "../db/client";
import { diskReservations } from "../security/disk-reservations";
import { importWorkbook } from "./excel-import-service";
import { importWorkbookStreaming } from "./streaming-xlsx-import-service";

const roots: string[] = [];
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
beforeAll(() => { fs.mkdirSync(config.dataDir, { recursive: true }); initDb(); });
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function workbook() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "import-budget-")); roots.push(root);
  const file = path.join(root, "same-image.xlsx"); const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("Sheet1");
  sheet.addRow(["source", "screenshot"]); sheet.addRow(["first", ""]); sheet.addRow(["second", ""]);
  const image = book.addImage({ buffer: pixel as any, extension: "png" }); sheet.addImage(image, "B2:B2"); sheet.addImage(image, "B3:B3");
  await book.xlsx.writeFile(file); return file;
}
describe.each([["streaming", importWorkbookStreaming], ["legacy", importWorkbook]] as const)("%s import reservations", (_name, run) => {
  it("counts repeated image anchors, releases on failure and then permits a complete import", async () => {
    const file = await workbook(); const sourceSize = fs.statSync(file).size;
    const jobs = db.prepare("SELECT COUNT(*) n FROM jobs").get().n;
    let free = config.minFreeDiskMb * 1048576 + sourceSize + pixel.length;
    vi.spyOn(fs, "statfsSync").mockImplementation(() => ({ bavail: free, bsize: 1 } as any));
    await expect(run(file, "test.xlsx")).rejects.toMatchObject({ status: 507 });
    expect(diskReservations.activeReservations).toBe(0); expect(db.prepare("SELECT COUNT(*) n FROM jobs").get().n).toBe(jobs);
    free += pixel.length;
    await expect(run(file, "test.xlsx", undefined, () => {
      expect(diskReservations.reservedBytes).toBe(pixel.length * 2);
      throw new Error("interrupted after source copy");
    })).rejects.toThrow("interrupted after source copy");
    expect(diskReservations.activeReservations).toBe(0); expect(fs.readdirSync(path.join(config.dataDir, "job-staging"))).toEqual([]);
    const result = await run(file, "test.xlsx"); roots.push(path.dirname(result.sourcePath));
    expect(result.totalRecords).toBe(2); expect(diskReservations.activeReservations).toBe(0);
    expect(fs.existsSync(file)).toBe(true); expect(fs.readFileSync(path.join(path.dirname(result.sourcePath), "images/1.png"))).toEqual(pixel);
  });
});
