import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { previewWorkbook } from "./excel-import-service";

const files: string[] = [];

afterEach(async () => {
  await Promise.all(files.splice(0).map((file) => fs.rm(file, { force: true })));
});

describe("Excel workbook preview", () => {
  it("summarizes sheets, headers, image counts, and image rows without creating a job", async () => {
    const file = path.join(os.tmpdir(), `preview-${Date.now()}.xlsx`);
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
    const preview = await previewWorkbook(file, "退货分析_测试.xlsx", { id: "refund", name: "退货分析", sourceFields: ["店铺名称", "不存在字段"] });
    expect(preview.originalFilename).toBe("退货分析_测试.xlsx");
    expect(preview.sheetCount).toBe(1);
    expect(preview.imageCount).toBe(1);
    expect(preview.sectionName).toBe("退货分析");
    expect(preview.missingHeaders).toEqual(["不存在字段"]);
    expect(preview.sheets[0]).toMatchObject({
      name: "售后记录",
      headers: ["店铺名称", "聊天截图"],
      imageCount: 1,
      imageRows: [2],
    });
  });

  it("normalizes leading and trailing whitespace in workbook headers", async () => {
    const file = path.join(os.tmpdir(), `preview-headers-${Date.now()}.xlsx`);
    files.push(file);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("质检");
    sheet.addRow(["平台", "接待流程质检结果 ", "聊天截图"]);
    sheet.addRow(["京东", "", ""]);
    sheet.addImage(workbook.addImage({ base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", extension: "png" }), {
      tl: { col: 2, row: 1 },
      ext: { width: 20, height: 20 },
    });
    await workbook.xlsx.writeFile(file);

    const preview = await previewWorkbook(file, "质检.xlsx", {
      id: "reception",
      name: "接待流程质检",
      sourceFields: ["平台", "接待流程质检结果", "聊天截图"],
    });

    expect(preview.missingHeaders).toEqual([]);
    expect(preview.sheets[0].headers).toEqual(["平台", "接待流程质检结果", "聊天截图"]);
  });
});
