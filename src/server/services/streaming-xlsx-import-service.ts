import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import unzipper from "unzipper";
import { XMLParser } from "fast-xml-parser";
import { addRecords, createJob, deleteJob, mergeSectionSourceFields, updateJobSourcePath } from "../db/repositories";
import { config } from "../config";
import { normalizeUploadedFilename } from "../utils/encoding";
import { normalizeImageAnchor } from "./excel-import-service";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", isArray: (name) => ["sheet", "Relationship", "row", "c", "si", "r", "oneCellAnchor", "twoCellAnchor"].includes(name) });
type StreamingAnchor = { row: number; column: number; embed: string; mediaPath?: string };

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function resolveZipPath(base: string, target: string) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(base), target));
}

function relationshipMap(xml: string) {
  const parsed = parser.parse(xml)?.Relationships?.Relationship;
  return new Map(asArray(parsed).map((item: any) => [item["@_Id"], item["@_Target"]] as const));
}

function columnNumber(ref: string) {
  const letters = ref.match(/[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

function sharedStringValues(xml: string) {
  const parsed = parser.parse(xml)?.sst?.si ?? [];
  return asArray(parsed).map((item: any) => {
    if (typeof item.t === "string") return item.t;
    return asArray(item.r).map((run: any) => typeof run.t === "string" ? run.t : "").join("");
  });
}

function worksheetRows(xml: string, sharedStrings: string[]) {
  const rows = new Map<number, Record<number, string>>();
  for (const row of asArray(parser.parse(xml)?.worksheet?.sheetData?.row)) {
    const rowNumber = Number(row["@_r"]);
    const cells: Record<number, string> = {};
    for (const cell of asArray(row.c)) {
      const ref = String(cell["@_r"] ?? "");
      const column = columnNumber(ref);
      const raw = cell.v;
      const value = cell["@_t"] === "s" ? sharedStrings[Number(raw)] ?? "" : raw === undefined ? "" : String(raw);
      cells[column] = value;
    }
    rows.set(rowNumber, cells);
  }
  return rows;
}

function drawingAnchors(xml: string): StreamingAnchor[] {
  const drawing = parser.parse(xml)?.["xdr:wsDr"] ?? {};
  return [...asArray(drawing["xdr:oneCellAnchor"]), ...asArray(drawing["xdr:twoCellAnchor"])]
    .map((anchor: any) => {
      const from = anchor["xdr:from"] ?? {};
      const pic = anchor["xdr:pic"] ?? {};
      return {
        row: Number(from["xdr:row"] ?? 0) + 1,
        column: Number(from["xdr:col"] ?? 0) + 1,
        embed: pic["xdr:blipFill"]?.["a:blip"]?.["@_r:embed"] as string | undefined,
      };
    })
    .filter((anchor): anchor is StreamingAnchor => Boolean(anchor.embed));
}

async function readEntry(directory: unzipper.CentralDirectory, entryPath: string) {
  const entry = directory.files.find((file) => file.path === entryPath);
  if (!entry) throw new Error(`XLSX 缺少文件：${entryPath}`);
  return (await entry.buffer()).toString("utf8");
}

async function readOptionalEntry(directory: unzipper.CentralDirectory, entryPath: string) {
  const entry = directory.files.find((file) => file.path === entryPath);
  return entry ? (await entry.buffer()).toString("utf8") : undefined;
}

export async function previewWorkbookStreaming(
  filePath: string,
  originalFilename: string,
  section?: { id: string; name: string; sourceFields?: string[] },
) {
  const directory = await unzipper.Open.file(filePath);
  const workbookXml = await readEntry(directory, "xl/workbook.xml");
  const workbookRelationships = relationshipMap(await readEntry(directory, "xl/_rels/workbook.xml.rels"));
  const sharedStringsPath = [...workbookRelationships.entries()].find(([, target]) => target.endsWith("sharedStrings.xml"))?.[1];
  const sharedStrings = sharedStringsPath ? sharedStringValues(await readEntry(directory, resolveZipPath("xl/workbook.xml", sharedStringsPath))) : [];
  const sheets = asArray(parser.parse(workbookXml)?.workbook?.sheets?.sheet);
  const summaries = [];
  for (const sheet of sheets) {
    const name = String((sheet as any)["@_name"]);
    const sheetPath = resolveZipPath("xl/workbook.xml", workbookRelationships.get((sheet as any)["@_r:id"]) ?? "");
    const sheetXml = await readEntry(directory, sheetPath);
    const rows = worksheetRows(sheetXml, sharedStrings);
    const relationshipsPath = resolveZipPath(sheetPath, `_rels/${path.posix.basename(sheetPath)}.rels`);
    const sheetRelationships = await readOptionalEntry(directory, relationshipsPath);
    const drawingTarget = [...relationshipMap(sheetRelationships ?? "").entries()]
      .find(([, target]) => target.includes("/drawing") || target.endsWith("drawing.xml"))?.[1];
    let imageRows: number[] = [];
    if (drawingTarget) {
      const drawingPath = resolveZipPath(sheetPath, drawingTarget);
      const drawingXml = await readEntry(directory, drawingPath);
      imageRows = drawingAnchors(drawingXml).map((anchor) => anchor.row);
    }
    summaries.push({
      name,
      headers: Object.values(rows.get(1) ?? {}),
      imageCount: imageRows.length,
      imageRows,
    });
  }
  const imageCount = summaries.reduce((sum, sheet) => sum + sheet.imageCount, 0);
  const headers = new Set(summaries.flatMap((sheet) => sheet.headers));
  return {
    originalFilename: normalizeUploadedFilename(originalFilename),
    sheetCount: summaries.length,
    imageCount,
    sectionId: section?.id,
    sectionName: section?.name,
    missingHeaders: (section?.sourceFields ?? []).filter((field) => !headers.has(field)),
    sheets: summaries,
  };
}

export async function importWorkbookStreaming(
  filePath: string,
  originalFilename: string,
  section?: { id: string; name: string },
  onProgress?: (progress: { totalImages?: number; processedImages: number; currentSheet: string; currentRow: number }) => void,
) {
  const directory = await unzipper.Open.file(filePath);
  const workbookXml = await readEntry(directory, "xl/workbook.xml");
  const workbookRelationships = relationshipMap(await readEntry(directory, "xl/_rels/workbook.xml.rels"));
  const sharedStringsPath = [...workbookRelationships.entries()].find(([, target]) => target.endsWith("sharedStrings.xml"))?.[1];
  const sharedStrings = sharedStringsPath ? sharedStringValues(await readEntry(directory, resolveZipPath("xl/workbook.xml", sharedStringsPath))) : [];
  const sheets = asArray(parser.parse(workbookXml)?.workbook?.sheets?.sheet);
  const sheetDefinitions = sheets.map((sheet: any) => ({
    name: String(sheet["@_name"]),
    path: resolveZipPath("xl/workbook.xml", workbookRelationships.get(sheet["@_r:id"]) ?? ""),
  })).filter((sheet) => sheet.path);
  const sheetData: Array<{
    name: string;
    path: string;
    rows: Map<number, Record<number, string>>;
    anchors: StreamingAnchor[];
  }> = [];
  for (const sheet of sheetDefinitions) {
    const sheetXml = await readEntry(directory, sheet.path);
    const relationshipsPath = resolveZipPath(sheet.path, `_rels/${path.posix.basename(sheet.path)}.rels`);
    const sheetRelationships = await readOptionalEntry(directory, relationshipsPath);
    const drawingTarget = [...relationshipMap(sheetRelationships ?? "").entries()]
      .find(([, target]) => target.includes("/drawing") || target.endsWith("drawing.xml"))?.[1];
    if (!drawingTarget) {
      sheetData.push({ ...sheet, rows: worksheetRows(sheetXml, sharedStrings), anchors: [] });
      continue;
    }
    const drawingPath = resolveZipPath(sheet.path, drawingTarget);
    const drawingXml = await readEntry(directory, drawingPath);
    const drawingRelationshipsPath = resolveZipPath(drawingPath, `_rels/${path.posix.basename(drawingPath)}.rels`);
    const drawingRelationships = relationshipMap(await readEntry(directory, drawingRelationshipsPath));
    const anchors = drawingAnchors(drawingXml).map((anchor) => ({
      ...anchor,
      mediaPath: resolveZipPath(drawingPath, drawingRelationships.get(anchor.embed!) ?? ""),
    }));
    sheetData.push({ ...sheet, rows: worksheetRows(sheetXml, sharedStrings), anchors });
  }
  const allImages = sheetData.flatMap((sheet) => sheet.anchors);
  if (!allImages.length) throw new Error("工作簿中没有识别到嵌入图片");
  const stagingDir = path.join(config.dataDir, "job-staging", crypto.randomUUID());
  const stagingImageDir = path.join(stagingDir, "images");
  let jobId: string | undefined;
  let finalJobDir: string | undefined;
  let processedImages = 0;
  const mediaByPath = new Map(directory.files.map((file) => [file.path, file]));
  try {
    await fsPromises.mkdir(stagingImageDir, { recursive: true });
    await fsPromises.copyFile(filePath, path.join(stagingDir, "source.xlsx"));
    onProgress?.({ totalImages: allImages.length, processedImages: 0, currentSheet: "", currentRow: 0 });
    const imported: Array<{ sheetName: string; rowNumber: number; anchor: unknown; sourceFields: Record<string, string>; imagePath: string }> = [];
    if (section) {
      const importedHeaders = [...new Set(sheetData.flatMap((sheet) => Object.values(sheet.rows.get(1) ?? {})))];
      mergeSectionSourceFields(section.id, importedHeaders);
    }
    for (const sheet of sheetData) {
      const headers = sheet.rows.get(1) ?? {};
      for (const image of sheet.anchors) {
        const sourceFields: Record<string, string> = {};
        const row = sheet.rows.get(image.row) ?? {};
        for (const [column, value] of Object.entries(row)) {
          const header = headers[Number(column)];
          if (header) sourceFields[header] = value;
        }
        const extension = path.extname(image.mediaPath ?? "").toLowerCase() || ".png";
        const target = path.join(stagingImageDir, `${processedImages + 1}${extension}`);
        const mediaEntry = image.mediaPath ? mediaByPath.get(image.mediaPath) : undefined;
        if (!mediaEntry) throw new Error(`第 ${image.row} 行图片资源不存在`);
        await pipeline(mediaEntry.stream(), fs.createWriteStream(target));
        const stat = await fsPromises.stat(target);
        if (!stat.size) throw new Error(`第 ${image.row} 行图片为空`);
        imported.push({ sheetName: sheet.name, rowNumber: image.row, anchor: normalizeImageAnchor({ tl: { nativeRow: image.row - 1, nativeCol: image.column - 1 }, br: { nativeRow: image.row - 1, nativeCol: image.column - 1 } }), sourceFields, imagePath: target });
        processedImages++;
        if (processedImages % 25 === 0) onProgress?.({ totalImages: allImages.length, processedImages, currentSheet: sheet.name, currentRow: image.row });
      }
    }
    const job = createJob(normalizeUploadedFilename(originalFilename), path.join(stagingDir, "source.xlsx"), section);
    jobId = job.id;
    const targetJobDir = path.join(config.dataDir, "jobs", job.id);
    finalJobDir = targetJobDir;
    await fsPromises.mkdir(path.dirname(targetJobDir), { recursive: true });
    await fsPromises.rename(stagingDir, targetJobDir);
    const sourcePath = path.join(targetJobDir, "source.xlsx");
    updateJobSourcePath(job.id, sourcePath);
    addRecords(job.id, imported.map((record) => ({ ...record, imagePath: path.join(targetJobDir, "images", path.basename(record.imagePath)) })));
    onProgress?.({ totalImages: allImages.length, processedImages, currentSheet: imported.at(-1)?.sheetName ?? "", currentRow: imported.at(-1)?.rowNumber ?? 0 });
    return { ...job, totalRecords: imported.length, sourcePath };
  } catch (error) {
    if (jobId) {
      try { deleteJob(jobId); } catch { /* clean files below */ }
    }
    await fsPromises.rm(finalJobDir ?? stagingDir, { recursive: true, force: true });
    throw error;
  }
}
