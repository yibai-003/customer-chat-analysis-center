import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initDb } from "../db/client";
import { importWorkbookStreaming, previewWorkbookStreaming } from "./streaming-xlsx-import-service";

const files: string[] = [];

afterEach(async () => {
  await Promise.all(files.splice(0).map((file) => fs.rm(file, { recursive: true, force: true })));
});

describe("streaming xlsx import", () => {
  beforeAll(() => initDb());

  it("extracts embedded images without loading the workbook through ExcelJS", async () => {
    const file = path.join(os.tmpdir(), `streaming-${Date.now()}.xlsx`);
    files.push(file);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("售后记录");
    sheet.addRow(["店铺名称", "聊天截图"]);
    sheet.addRow(["测试店铺", ""]);
    sheet.addImage(workbook.addImage({ base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", extension: "png" }), {
      tl: { col: 1, row: 1 },
      ext: { width: 20, height: 20 },
    });
    await workbook.xlsx.writeFile(file);
    const progress: number[] = [];
    const result = await importWorkbookStreaming(file, "streaming.xlsx", undefined, (next) => progress.push(next.processedImages));
    files.push(path.dirname(result.sourcePath));
    expect(result.totalRecords).toBe(1);
    expect(progress).toContain(1);
  });

  it("previews workbook metadata through ZIP/XML entries", async () => {
    const file = path.join(os.tmpdir(), `streaming-preview-${Date.now()}.xlsx`);
    files.push(file);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("售后记录");
    sheet.addRow(["店铺名称", "聊天截图"]);
    sheet.addRow(["测试店铺", ""]);
    sheet.addImage(workbook.addImage({ base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", extension: "png" }), {
      tl: { col: 1, row: 1 },
      ext: { width: 20, height: 20 },
    });
    await workbook.xlsx.writeFile(file);
    const preview = await previewWorkbookStreaming(file, "streaming-preview.xlsx", { id: "refund", name: "退货分析", sourceFields: ["店铺名称"] });
    expect(preview).toMatchObject({
      originalFilename: "streaming-preview.xlsx",
      imageCount: 1,
      sectionName: "退货分析",
      missingHeaders: [],
    });
  });

  it("normalizes a shared-string header that preserves trailing whitespace", async () => {
    const file = path.join(os.tmpdir(), `streaming-whitespace-${Date.now()}.xlsx`);
    files.push(file);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("质检明细");
    sheet.addRow(["平台", "接待流程质检结果 ", "聊天截图"]);
    sheet.addRow(["测试平台", "", ""]);
    await workbook.xlsx.writeFile(file);

    const preview = await previewWorkbookStreaming(file, "质检明细.xlsx", {
      id: "reception-quality",
      name: "接待流程质检",
      sourceFields: ["平台", "接待流程质检结果", "聊天截图"],
    });

    expect(preview.sheets[0]?.headers).toEqual(["平台", "接待流程质检结果", "聊天截图"]);
    expect(preview.missingHeaders).toEqual([]);
  });
});
