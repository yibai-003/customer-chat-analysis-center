import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import unzipper from "unzipper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateXlsx, requireDiskSpace, defaultXlsxLimits } from "./upload-safety";
import { createApp } from "../app";
import { config } from "../config";

let directory: string;
let file: string;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "xlsx-safety-"));
  fs.mkdirSync(config.dataDir, { recursive: true });
  file = path.join(directory, "test.xlsx");
  const w = new ExcelJS.Workbook(); const s = w.addWorksheet("Sheet1"); s.addRow(["Header"]); s.addRow(["value"]);
  await w.xlsx.writeFile(file);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
describe("upload safety", () => {
  it("accepts a genuine workbook with bounded file reads", async () => {
    const spy = vi.spyOn(fs, "readFileSync");
    const result = await validateXlsx(file, "test.xlsx");
    expect(result.entries).toBeGreaterThan(4);
    expect(spy.mock.calls.some(args => args[0] === file)).toBe(false);
  });
  it("rejects fake and truncated ZIPs", async () => {
    fs.writeFileSync(file, "not an xlsx");
    await expect(validateXlsx(file, "test.xlsx")).rejects.toMatchObject({ status: 415 });
    fs.writeFileSync(file, Buffer.from([0x50,0x4b,0x03,0x04,0,0]));
    await expect(validateXlsx(file, "test.xlsx")).rejects.toMatchObject({ status: 415 });
  });
  it("rejects excessive entry count and inflated size", async () => {
    await expect(validateXlsx(file, "test.xlsx", { ...defaultXlsxLimits, entries: 1 })).rejects.toMatchObject({ status: 413 });
    await expect(validateXlsx(file, "test.xlsx", { ...defaultXlsxLimits, totalBytes: 10 })).rejects.toMatchObject({ status: 413 });
  });
  it.each(["traversal", "encrypted", "missing", "duplicate", "lying-size"])("rejects %s archive entries", async scenario => {
    const archive = await unzipper.Open.file(file);
    if (scenario === "traversal") archive.files[0].path = "../outside";
    if (scenario === "encrypted") archive.files[0].flags |= 1;
    if (scenario === "missing") archive.files = archive.files.filter(f => f.path !== "xl/workbook.xml");
    if (scenario === "duplicate") archive.files.push(archive.files[0]);
    if (scenario === "lying-size") archive.files.find(f => f.type === "File")!.uncompressedSize = 1;
    vi.spyOn(unzipper.Open, "file").mockResolvedValue(archive);
    await expect(validateXlsx(file, "test.xlsx")).rejects.toMatchObject({ status: 415 });
  });
  it("fails closed when space cannot be measured", () => {
    vi.spyOn(fs, "statfsSync").mockImplementation(() => { throw new Error("permission denied"); });
    expect(() => requireDiskSpace()).toThrow("无法检查");
  });
  it("distinguishes low disk space and removes an uploaded invalid file", async () => {
    const server = createApp().listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const root = path.join(config.dataDir, "uploads");
      const before = fs.readdirSync(root);
      let form = new FormData(); form.append("file", new Blob(["invalid"]), "test.xlsx");
      const response = await fetch(base + "/api/jobs/import", { method: "POST", body: form });
      expect(response.status).toBe(415);
      expect(fs.readdirSync(root)).toEqual(before);
      vi.spyOn(fs, "statfsSync").mockReturnValue({ bavail: 0, bsize: 4096 } as any);
      form = new FormData(); form.append("file", new Blob(["invalid"]), "test.xlsx");
      const lowDisk = await fetch(base + "/api/jobs/import-preview", { method: "POST", body: form });
      expect(lowDisk.status).toBe(507);
      expect((await lowDisk.json()).error).toContain("磁盘空间不足");
      expect(fs.readdirSync(root)).toEqual(before);
      vi.restoreAllMocks();
      vi.spyOn(fs, "statfsSync").mockReturnValueOnce({ bavail: 1e9, bsize: 4096 } as any).mockReturnValue({ bavail: 0, bsize: 4096 } as any);
      form = new FormData(); form.append("file", new Blob([fs.readFileSync(file)]), "test.xlsx");
      const interrupted = await fetch(base + "/api/jobs/import", { method: "POST", body: form });
      expect(interrupted.status).toBe(507);
      expect(fs.readdirSync(root)).toEqual(before);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
