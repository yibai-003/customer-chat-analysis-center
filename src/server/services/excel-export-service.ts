import path from "node:path";
import ExcelJS from "exceljs";
import { getJob, listRecords, getRecord, listSections } from "../db/repositories";
import { db } from "../db/client";
import { config } from "../config";
import { listFields } from "./field-config-service";
import { aggregateFieldResults } from "./field-run-service";
import { buildOutputPlan } from "./excel-template-service";

export function exportColumns(sections: ReturnType<typeof listSections>) {
  return sections.flatMap((section) => listFields(section.id)
    .filter((field) => field.exportEnabled !== false)
    .map((field) => ({
    key: field.key,
    header: `${section.name}_${field.label}`,
  })));
}

export function exportMetadataHeaders() {
  return [] as string[];
}

export async function exportJob(jobId: string, sectionIds: string[]) {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");
  const workbook = new ExcelJS.Workbook();
  const sourcePath = (db.prepare("SELECT source_path FROM jobs WHERE id = ?").get(jobId) as { source_path: string } | undefined)?.source_path;
  if (!sourcePath) throw new Error("原始工作簿不存在");
  await workbook.xlsx.readFile(sourcePath);
  const sections = listSections().filter((section) => sectionIds.includes(section.id));
  for (const worksheet of workbook.worksheets) {
    const records = listRecords(jobId).filter((record) => record.sheetName === worksheet.name);
    if (!records.length) continue;
    const headerRow = worksheet.getRow(1);
    const sourceHeaders = Array.from({ length: headerRow.cellCount }, (_, index) => String(headerRow.getCell(index + 1).value ?? ""));
    const plans: Array<{ section: typeof sections[number]; fields: ReturnType<typeof listFields>; output: ReturnType<typeof buildOutputPlan> }> = [];
    let headers = sourceHeaders.slice();
    for (const section of sections) {
      const fields = listFields(section.id).filter((field) => field.exportEnabled !== false);
      const output = buildOutputPlan(headers, fields);
      output.forEach((item) => { headers[item.column - 1] = item.header; });
      plans.push({ section, fields, output });
    }
    const metadata = exportMetadataHeaders().map((header, index) => ({ header, column: headers.length + index + 1 }));
    [...plans.flatMap((item) => item.output), ...metadata].forEach((item) => {
      if (!headerRow.getCell(item.column).value) headerRow.getCell(item.column).value = item.header;
    });
    for (const record of records) {
      const detail = getRecord(record.id)!;
      const row = worksheet.getRow(record.rowNumber);
      for (const plan of plans) {
        const { section, fields, output } = plan;
        const run = detail.analysisRuns.find((item) => item.sectionId === section.id);
        const fieldResult = aggregateFieldResults(record.id, section.id);
        const sectionReview = detail.sectionReviews?.[section.id];
        const result = sectionReview?.humanResult ?? detail.humanResult ?? (Object.keys(fieldResult).length ? fieldResult : run?.result ?? {});
        for (const field of fields) {
          const target = output.find((item) => item.key === field.key)!;
          row.getCell(target.column).value = (result[field.key] ?? "") as any;
        }
      }
      if (metadata.length >= 3) {
        row.getCell(metadata[0].column).value = detail.status;
        row.getCell(metadata[1].column).value = detail.reviewStatus;
        row.getCell(metadata[2].column).value = detail.reviewNote;
      }
    }
  }
  const exportDir = path.join(config.dataDir, "exports");
  await (await import("node:fs/promises")).mkdir(exportDir, { recursive: true });
  const output = path.join(exportDir, `${job.id}-客服解析结果.xlsx`);
  await workbook.xlsx.writeFile(output);
  return output;
}
