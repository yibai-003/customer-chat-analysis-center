import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import ExcelJS from "exceljs";

export interface KnowledgeWorkbookFixture {
  headers: string[];
  rows: unknown[][];
  emptyWorksheetFirst?: boolean;
  sheetName?: string;
}

export async function createKnowledgeWorkbook(
  fixture: KnowledgeWorkbookFixture,
): Promise<string> {
  const directory = path.join(os.tmpdir(), "knowledge-import-tests");
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${crypto.randomUUID()}.xlsx`);
  const workbook = new ExcelJS.Workbook();

  if (fixture.emptyWorksheetFirst) {
    workbook.addWorksheet("空白页");
  }

  const worksheet = workbook.addWorksheet(fixture.sheetName ?? "知识库");
  worksheet.addRow(fixture.headers);
  for (const row of fixture.rows) {
    worksheet.addRow(row);
  }

  await workbook.xlsx.writeFile(filePath);
  return filePath;
}
