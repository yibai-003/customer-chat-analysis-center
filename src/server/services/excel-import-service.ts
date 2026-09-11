import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { createJob, addRecords, deleteJob, mergeSectionSourceFields, updateJobSourcePath } from "../db/repositories";
import { config } from "../config";
import { normalizeUploadedFilename } from "../utils/encoding";

export function normalizeImageAnchor(range: any) {
  const startRow = Number(range?.tl?.nativeRow ?? range?.tl?.row ?? 0) + 1;
  const startColumn = Number(range?.tl?.nativeCol ?? range?.tl?.col ?? 0) + 1;
  const endRow = Number(range?.br?.nativeRow ?? range?.br?.row ?? startRow - 1) + 1;
  const endColumn = Number(range?.br?.nativeCol ?? range?.br?.col ?? startColumn - 1) + 1;
  return { startRow, startColumn, endRow, endColumn };
}

export async function previewWorkbook(filePath: string, originalFilename: string, section?: { id: string; name: string; sourceFields?: string[] }) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheets = workbook.worksheets.map((worksheet) => {
    const headers: string[] = [];
    worksheet.getRow(1).eachCell((cell, index) => { headers[index - 1] = String(cell.value ?? `字段${index}`); });
    const images = (worksheet.getImages?.() ?? []) as any[];
    return {
      name: worksheet.name,
      headers: headers.filter(Boolean),
      imageCount: images.length,
      imageRows: images.map((image) => Number(image.range?.tl?.nativeRow ?? image.range?.tl?.row ?? 1) + 1),
    };
  });
  const imageCount = sheets.reduce((sum, sheet) => sum + sheet.imageCount, 0);
  const headers = new Set(sheets.flatMap((sheet) => sheet.headers));
  const missingHeaders = (section?.sourceFields ?? []).filter((field) => !headers.has(field));
  return { originalFilename: normalizeUploadedFilename(originalFilename), sheetCount: sheets.length, imageCount, sectionId: section?.id, sectionName: section?.name, missingHeaders, sheets };
}

export async function importWorkbook(filePath: string, originalFilename: string, section?: { id: string; name: string }, onProgress?: (progress: { totalImages?: number; processedImages: number; currentSheet: string; currentRow: number }) => void) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const stagingDir = path.join(config.dataDir, "job-staging", crypto.randomUUID());
  const stagingImageDir = path.join(stagingDir, "images");
  let jobId: string | undefined;
  let finalJobDir: string | undefined;
    const imported: Array<{ sheetName: string; rowNumber: number; anchor: unknown; sourceFields: Record<string, string>; imagePath: string }> = [];
    if (section) {
      const importedHeaders = [...new Set(workbook.worksheets.flatMap((worksheet) => {
        const headers: string[] = [];
        worksheet.getRow(1).eachCell((cell, index) => { headers[index - 1] = String(cell.value ?? ""); });
        return headers;
      }))];
      mergeSectionSourceFields(section.id, importedHeaders);
    }
  try {
    await fs.mkdir(stagingImageDir, { recursive: true });
    await fs.copyFile(filePath, path.join(stagingDir, "source.xlsx"));
    const totalImages = workbook.worksheets.reduce((count, worksheet) => count + ((worksheet.getImages?.() ?? []) as any[]).length, 0);
    onProgress?.({ totalImages, processedImages: 0, currentSheet: "", currentRow: 0 });
    for (const worksheet of workbook.worksheets) {
      const headers: string[] = [];
      worksheet.getRow(1).eachCell((cell, index) => { headers[index] = String(cell.value ?? `字段${index}`); });
      const images = (worksheet.getImages?.() ?? []) as any[];
      for (const image of images) {
        const range = image.range;
        const rowNumber = Number(range.tl?.nativeRow ?? range.tl?.row ?? 1) + 1;
        const sourceFields: Record<string, string> = {};
        worksheet.getRow(rowNumber).eachCell((cell, index) => { if (headers[index]) sourceFields[headers[index]] = String(cell.text ?? cell.value ?? ""); });
        const media = (workbook as any).model.media?.find((item: any) => item.index === image.imageId || item.imageId === image.imageId);
        const extension = media?.extension ?? "png";
        if (!media?.buffer?.length) throw new Error(`第 ${rowNumber} 行图片无法读取`);
        const target = path.join(stagingImageDir, `${imported.length + 1}.${extension}`);
        await fs.writeFile(target, media.buffer);
        imported.push({ sheetName: worksheet.name, rowNumber, anchor: normalizeImageAnchor(range), sourceFields, imagePath: target });
        if (onProgress && (imported.length % 25 === 0)) onProgress({ totalImages, processedImages: imported.length, currentSheet: worksheet.name, currentRow: rowNumber });
      }
    }
    if (!imported.length) throw new Error("工作簿中没有识别到嵌入图片");
    const job = createJob(normalizeUploadedFilename(originalFilename), path.join(stagingDir, "source.xlsx"), section);
    jobId = job.id;
    const targetJobDir = path.join(config.dataDir, "jobs", job.id);
    finalJobDir = targetJobDir;
    await fs.mkdir(path.dirname(targetJobDir), { recursive: true });
    await fs.rename(stagingDir, targetJobDir);
    const finalSourcePath = path.join(targetJobDir, "source.xlsx");
    updateJobSourcePath(job.id, finalSourcePath);
    addRecords(job.id, imported.map((record) => ({
      ...record,
      imagePath: path.join(targetJobDir, "images", path.basename(record.imagePath)),
    })));
    onProgress?.({ totalImages, processedImages: imported.length, currentSheet: imported.at(-1)?.sheetName ?? "", currentRow: imported.at(-1)?.rowNumber ?? 0 });
    return { ...job, totalRecords: imported.length, sourcePath: finalSourcePath };
  } catch (error) {
    if (jobId) {
      try { deleteJob(jobId); } catch { /* cleanup continues below */ }
    }
    await fs.rm(finalJobDir ?? stagingDir, { recursive: true, force: true });
    throw error;
  }
}
