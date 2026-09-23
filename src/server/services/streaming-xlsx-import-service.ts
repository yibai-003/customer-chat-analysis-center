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
import { diskReservations, reservedFileWriter } from "../security/disk-reservations";
import {
  excelHeaderMatches,
  excelHeaderParts,
  normalizeExcelHeader,
} from "./excel-template-service";
import { getSectionVersion } from "./section-config-version-service";
import type { ReceptionImportContract } from "./section-business-rules";
import {
  inspectReceptionResultRow,
  receptionImportConflictMessage,
  type ReceptionImportConflict,
} from "./reception-import-contract";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", isArray: (name) => ["sheet", "Relationship", "row", "c", "si", "r", "oneCellAnchor", "twoCellAnchor"].includes(name) });
type StreamingAnchor = { row: number; column: number; embed: string; mediaPath?: string };
type PlatformInput = { id: string; name: string; code: string };
type SectionInput = { id: string; name: string; sourceFields?: string[]; sectionConfigVersionId?: string; sectionVersionNumber?: number };

const receptionHeaderKeys: Record<string, string[]> = {
  平台: ["platform_name"],
  店铺: ["store_name"],
  日期: ["business_date"],
  客服: ["agent_name"],
  分组: ["agent_group"],
  客户ID: ["customer_id"],
  聊天截图: ["chat_screenshot"],
};
const modernReceptionResultKeys = new Set([
  "conversation_started_at",
  "conversation_id",
  "turn_count",
  "rating",
  "total_deduction",
  "improvement_advice",
  "needs_manual_review",
  "dimension",
  "issue",
  "deduction",
  "d_level",
  "chat_excerpt",
  "evidence",
  "judgement_reason",
]);
const modernReceptionRequiredResultKeys = new Set([
  "conversation_id",
  "turn_count",
  "rating",
  "total_deduction",
  "needs_manual_review",
]);

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function resolveZipPath(base: string, target: string) {
  if (target.startsWith("/")) return path.posix.normalize(target.slice(1));
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

function xmlText(value: unknown) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  const text = (value as Record<string, unknown>)["#text"];
  return typeof text === "string" || typeof text === "number" ? String(text) : "";
}

function sharedStringValues(xml: string) {
  const parsed = parser.parse(xml)?.sst?.si ?? [];
  return asArray(parsed).map((item: any) => {
    const directText = xmlText(item.t);
    if (directText) return directText;
    return asArray(item.r).map((run: any) => xmlText(run.t)).join("");
  });
}

export function parseWorksheetRows(xml: string, sharedStrings: string[]) {
  const rows = new Map<number, Record<number, string>>();
  for (const row of asArray(parser.parse(xml)?.worksheet?.sheetData?.row)) {
    const rowNumber = Number(row["@_r"]);
    const cells: Record<number, string> = {};
    for (const cell of asArray(row.c)) {
      const ref = String(cell["@_r"] ?? "");
      const column = columnNumber(ref);
      const raw = cell.v;
      const inlineText = xmlText(cell.is?.t)
        || asArray(cell.is?.r).map((run: any) => xmlText(run.t)).join("");
      const value = cell["@_t"] === "s"
        ? sharedStrings[Number(raw)] ?? ""
        : cell["@_t"] === "inlineStr"
          ? inlineText
          : raw === undefined ? "" : String(raw);
      cells[column] = value;
    }
    rows.set(rowNumber, cells);
  }
  return rows;
}

function normalizedPlatformValue(value: string) {
  return value.trim().toLocaleLowerCase();
}

function receptionHeaderMatches(actual: unknown, expected: string) {
  if (excelHeaderMatches(actual, expected)) return true;
  const key = excelHeaderParts(actual).key;
  return Boolean(key && receptionHeaderKeys[expected]?.includes(key));
}

function platformConflicts(
  sheetData: Array<{ name: string; rows: Map<number, Record<number, string>> }>,
  platform?: PlatformInput,
) {
  if (!platform) return [];
  const accepted = new Set([normalizedPlatformValue(platform.name), normalizedPlatformValue(platform.code)]);
  const conflicts: Array<{ sheetName: string; rowNumber: number; value: string }> = [];
  for (const sheet of sheetData) {
    const headers = sheet.rows.get(1) ?? {};
    const platformColumn = Object.entries(headers).find(([, value]) => receptionHeaderMatches(value, "平台"))?.[0];
    if (!platformColumn) continue;
    for (const [rowNumber, row] of sheet.rows) {
      if (rowNumber === 1) continue;
      const value = String(row[Number(platformColumn)] ?? "").trim();
      if (value && !accepted.has(normalizedPlatformValue(value))) {
        conflicts.push({ sheetName: sheet.name, rowNumber, value });
      }
    }
  }
  return conflicts;
}

function platformConflictMessage(conflicts: Array<{ sheetName: string; rowNumber: number; value: string }>) {
  return `Excel 中的平台字段与所选平台不一致：${conflicts.map((conflict) => `${conflict.sheetName} 第 ${conflict.rowNumber} 行“${conflict.value}”`).join("；")}`;
}

export function parseDrawingAnchors(xml: string): StreamingAnchor[] {
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

function rowSourceFields(
  rows: Map<number, Record<number, string>>,
  rowNumber: number,
) {
  const headers = rows.get(1) ?? {};
  const row = rows.get(rowNumber) ?? {};
  const sourceFields: Record<string, string> = {};
  for (const [column, value] of Object.entries(row)) {
    const header = normalizeExcelHeader(headers[Number(column)]);
    if (header) sourceFields[header] = value;
  }
  return sourceFields;
}

function receptionContractForHeaders(
  headers: Record<number, string>,
  contract: ReceptionImportContract,
) {
  const modernColumns = Object.values(headers)
    .map((header) => ({ header: normalizeExcelHeader(header), key: excelHeaderParts(header).key }))
    .filter((item) => modernReceptionResultKeys.has(item.key));
  if (!modernColumns.length) return contract;
  return {
    imageColumn: contract.imageColumn,
    resultColumns: modernColumns.map((item) => item.header),
    completeHistoricalResultRequiredColumns: modernColumns
      .filter((item) => modernReceptionRequiredResultKeys.has(item.key))
      .map((item) => item.header),
  };
}

function resolveReceptionContract(section?: SectionInput): ReceptionImportContract | undefined {
  if (section?.id !== "reception") return;
  if (!section.sectionConfigVersionId) throw new Error("接待质检导入缺少配置版本");
  const version = getSectionVersion(section.sectionConfigVersionId);
  if (!version || version.sectionId !== "reception") throw new Error("接待质检导入配置版本无效");
  const contract = (version.businessRules as { importContract?: ReceptionImportContract }).importContract;
  if (!contract) throw new Error("接待质检配置版本缺少导入契约");
  return contract;
}

function anchorsForContract(
  sheet: { rows: Map<number, Record<number, string>>; anchors: StreamingAnchor[] },
  contract?: ReceptionImportContract,
) {
  if (!contract) return sheet.anchors;
  const imageHeader = Object.entries(sheet.rows.get(1) ?? {})
    .find(([, value]) => receptionHeaderMatches(value, contract.imageColumn));
  const imageColumn = imageHeader?.[0];
  if (!imageColumn) return [];
  const seenRows = new Set<number>();
  const anchoredInImageColumn = sheet.anchors.filter((anchor) => {
    if (anchor.column !== Number(imageColumn) || seenRows.has(anchor.row)) return false;
    seenRows.add(anchor.row);
    return true;
  });
  if (anchoredInImageColumn.length || excelHeaderParts(imageHeader?.[1]).key !== "chat_screenshot") {
    return anchoredInImageColumn;
  }

  // WPS can retain the screenshot header while serializing floating images against
  // an earlier column after columns were rearranged. When every image is uniquely
  // associated with a data row, preserve the reliable row anchor instead.
  seenRows.clear();
  return sheet.anchors.filter((anchor) => {
    if (anchor.row <= 1 || seenRows.has(anchor.row)) return false;
    seenRows.add(anchor.row);
    return true;
  });
}

function inspectReceptionSheets(
  sheetData: Array<{
    name: string;
    rows: Map<number, Record<number, string>>;
    anchors: StreamingAnchor[];
  }>,
  contract?: ReceptionImportContract,
) {
  const pending: Array<{ sheetName: string; anchor: StreamingAnchor; sourceFields: Record<string, string> }> = [];
  const historical: Array<{ sheetName: string; rowNumber: number }> = [];
  const conflicts: ReceptionImportConflict[] = [];
  const eligibleRows = new Set<string>();
  if (!contract) return { pending, historical, conflicts, eligibleRows };

  for (const sheet of sheetData) {
    for (const anchor of anchorsForContract(sheet, contract)) {
      eligibleRows.add(`${sheet.name}\u0000${anchor.row}`);
      const sourceFields = rowSourceFields(sheet.rows, anchor.row);
      const resolvedContract = receptionContractForHeaders(sheet.rows.get(1) ?? {}, contract);
      const inspection = inspectReceptionResultRow(sourceFields, resolvedContract);
      if (inspection.status === "empty") {
        for (const field of resolvedContract.resultColumns) delete sourceFields[field];
        pending.push({ sheetName: sheet.name, anchor, sourceFields });
      } else if (inspection.status === "complete") {
        historical.push({ sheetName: sheet.name, rowNumber: anchor.row });
      } else {
        conflicts.push({
          sheetName: sheet.name,
          rowNumber: anchor.row,
          ...inspection,
        });
      }
    }
  }
  return { pending, historical, conflicts, eligibleRows };
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
  section?: SectionInput,
  platform?: PlatformInput,
) {
  const directory = await unzipper.Open.file(filePath);
  const workbookXml = await readEntry(directory, "xl/workbook.xml");
  const workbookRelationships = relationshipMap(await readEntry(directory, "xl/_rels/workbook.xml.rels"));
  const sharedStringsPath = [...workbookRelationships.entries()].find(([, target]) => target.endsWith("sharedStrings.xml"))?.[1];
  const sharedStrings = sharedStringsPath ? sharedStringValues(await readEntry(directory, resolveZipPath("xl/workbook.xml", sharedStringsPath))) : [];
  const sheets = asArray(parser.parse(workbookXml)?.workbook?.sheets?.sheet);
  const sheetData: Array<{
    name: string;
    rows: Map<number, Record<number, string>>;
    anchors: StreamingAnchor[];
  }> = [];
  for (const sheet of sheets) {
    const name = String((sheet as any)["@_name"]);
    const sheetPath = resolveZipPath("xl/workbook.xml", workbookRelationships.get((sheet as any)["@_r:id"]) ?? "");
    const sheetXml = await readEntry(directory, sheetPath);
    const rows = parseWorksheetRows(sheetXml, sharedStrings);
    const relationshipsPath = resolveZipPath(sheetPath, `_rels/${path.posix.basename(sheetPath)}.rels`);
    const sheetRelationships = await readOptionalEntry(directory, relationshipsPath);
    const drawingTarget = [...relationshipMap(sheetRelationships ?? "").entries()]
      .find(([, target]) => target.includes("/drawing") || target.endsWith("drawing.xml"))?.[1];
    let anchors: StreamingAnchor[] = [];
    if (drawingTarget) {
      const drawingPath = resolveZipPath(sheetPath, drawingTarget);
      const drawingXml = await readEntry(directory, drawingPath);
      anchors = parseDrawingAnchors(drawingXml);
    }
    sheetData.push({ name, rows, anchors });
  }
  const contract = resolveReceptionContract(section);
  const reception = inspectReceptionSheets(sheetData, contract);
  const summaries = sheetData.map((sheet) => {
    const supportedAnchors = anchorsForContract(sheet, contract);
    return {
      name: sheet.name,
      headers: Object.values(sheet.rows.get(1) ?? {}).map(normalizeExcelHeader).filter(Boolean),
      imageCount: supportedAnchors.length,
      imageRows: supportedAnchors.map((anchor) => anchor.row).sort((left, right) => left - right),
    };
  });
  const imageCount = summaries.reduce((sum, sheet) => sum + sheet.imageCount, 0);
  const headers = new Set(summaries.flatMap((sheet) => sheet.headers));
  const conflicts = platformConflicts(sheetData, platform);
  return {
    originalFilename: normalizeUploadedFilename(originalFilename),
    sheetCount: summaries.length,
    imageCount,
    sectionId: section?.id,
    sectionName: section?.name,
    sectionConfigVersionId: section?.sectionConfigVersionId,
    sectionVersionNumber: section?.sectionVersionNumber,
    platformId: platform?.id,
    platformCode: platform?.code,
    platformName: platform?.name,
    platformConflicts: conflicts,
    pendingRecordCount: contract ? reception.pending.length : imageCount,
    historicalResultCount: reception.historical.length,
    resultConflicts: reception.conflicts,
    missingHeaders: contract
      ? [contract.imageColumn].filter((field) =>
        !summaries.some((sheet) => sheet.headers.some((header) => receptionHeaderMatches(header, field))))
      : (section?.sourceFields ?? []).filter((field) => !headers.has(field)),
    sheets: summaries,
  };
}

export async function importWorkbookStreaming(
  filePath: string,
  originalFilename: string,
  section?: SectionInput,
  onProgress?: (progress: { totalImages?: number; processedImages: number; currentSheet: string; currentRow: number }) => void,
  platform?: PlatformInput,
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
      sheetData.push({ ...sheet, rows: parseWorksheetRows(sheetXml, sharedStrings), anchors: [] });
      continue;
    }
    const drawingPath = resolveZipPath(sheet.path, drawingTarget);
    const drawingXml = await readEntry(directory, drawingPath);
    const drawingRelationshipsPath = resolveZipPath(drawingPath, `_rels/${path.posix.basename(drawingPath)}.rels`);
    const drawingRelationships = relationshipMap(await readEntry(directory, drawingRelationshipsPath));
    const anchors = parseDrawingAnchors(drawingXml).map((anchor) => ({
      ...anchor,
      mediaPath: resolveZipPath(drawingPath, drawingRelationships.get(anchor.embed!) ?? ""),
    }));
    sheetData.push({ ...sheet, rows: parseWorksheetRows(sheetXml, sharedStrings), anchors });
  }
  const contract = resolveReceptionContract(section);
  const reception = inspectReceptionSheets(sheetData, contract);
  const supportedImages = sheetData.flatMap((sheet) => anchorsForContract(sheet, contract));
  if (!supportedImages.length) throw new Error(contract
    ? `工作簿中没有识别到“${contract.imageColumn}”列的聊天截图`
    : "工作簿中没有识别到嵌入图片");
  const conflicts = platformConflicts(sheetData, platform);
  if (conflicts.length) throw new Error(platformConflictMessage(conflicts));
  if (reception.conflicts.length) throw new Error(receptionImportConflictMessage(reception.conflicts));
  const imagesToImport = contract
    ? reception.pending.map((item) => item.anchor)
    : supportedImages;
  const stagingDir = path.join(config.dataDir, "job-staging", crypto.randomUUID());
  const stagingImageDir = path.join(stagingDir, "images");
  let jobId: string | undefined;
  let finalJobDir: string | undefined;
  let processedImages = 0;
  const mediaByPath = new Map(directory.files.map((file) => [file.path, file]));
  // Count each anchor: one embedded media file can be written once per worksheet record.
  const imageBytes = imagesToImport.reduce((sum, image) => {
    const entry = image.mediaPath ? mediaByPath.get(image.mediaPath) : undefined;
    if (!entry || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 1) throw new Error("图片资源缺失或声明大小无效");
    return sum + entry.uncompressedSize;
  }, 0);
  const sourceBytes = (await fsPromises.stat(filePath)).size;
  const reservation = diskReservations.reserve(sourceBytes + imageBytes);
  try {
    await fsPromises.mkdir(stagingImageDir, { recursive: true });
    await pipeline(fs.createReadStream(filePath), reservedFileWriter(path.join(stagingDir, "source.xlsx"), reservation));
    onProgress?.({ totalImages: imagesToImport.length, processedImages: 0, currentSheet: "", currentRow: 0 });
    const imported: Array<{ sheetName: string; rowNumber: number; anchor: unknown; sourceFields: Record<string, string>; imagePath: string }> = [];
    if (section) {
      const importedHeaders = [...new Set(sheetData.flatMap((sheet) =>
        Object.values(sheet.rows.get(1) ?? {}).map(normalizeExcelHeader).filter(Boolean)))];
      mergeSectionSourceFields(section.id, importedHeaders);
    }
    for (const sheet of sheetData) {
      const pendingByRow = new Map(reception.pending
        .filter((item) => item.sheetName === sheet.name)
        .map((item) => [item.anchor.row, item.sourceFields]));
      const anchors = contract
        ? anchorsForContract(sheet, contract).filter((image) => pendingByRow.has(image.row))
        : sheet.anchors;
      for (const image of anchors) {
        const sourceFields = contract
          ? pendingByRow.get(image.row)!
          : rowSourceFields(sheet.rows, image.row);
        const extension = path.extname(image.mediaPath ?? "").toLowerCase() || ".png";
        const target = path.join(stagingImageDir, `${processedImages + 1}${extension}`);
        const mediaEntry = image.mediaPath ? mediaByPath.get(image.mediaPath) : undefined;
        if (!mediaEntry) throw new Error(`第 ${image.row} 行图片资源不存在`);
        await pipeline(mediaEntry.stream(), reservedFileWriter(target, reservation));
        const stat = await fsPromises.stat(target);
        if (!stat.size) throw new Error(`第 ${image.row} 行图片为空`);
        imported.push({ sheetName: sheet.name, rowNumber: image.row, anchor: normalizeImageAnchor({ tl: { nativeRow: image.row - 1, nativeCol: image.column - 1 }, br: { nativeRow: image.row - 1, nativeCol: image.column - 1 } }), sourceFields, imagePath: target });
        processedImages++;
        if (processedImages % 25 === 0) onProgress?.({ totalImages: imagesToImport.length, processedImages, currentSheet: sheet.name, currentRow: image.row });
      }
    }
    const job = createJob(
      normalizeUploadedFilename(originalFilename),
      path.join(stagingDir, "source.xlsx"),
      section,
      platform,
      section?.sectionConfigVersionId,
    );
    jobId = job.id;
    const targetJobDir = path.join(config.dataDir, "jobs", job.id);
    finalJobDir = targetJobDir;
    await fsPromises.mkdir(path.dirname(targetJobDir), { recursive: true });
    await fsPromises.rename(stagingDir, targetJobDir);
    const sourcePath = path.join(targetJobDir, "source.xlsx");
    updateJobSourcePath(job.id, sourcePath);
    addRecords(job.id, imported.map((record) => ({ ...record, imagePath: path.join(targetJobDir, "images", path.basename(record.imagePath)) })));
    onProgress?.({ totalImages: imagesToImport.length, processedImages, currentSheet: imported.at(-1)?.sheetName ?? "", currentRow: imported.at(-1)?.rowNumber ?? 0 });
    return { ...job, totalRecords: imported.length, sourcePath };
  } catch (error) {
    if (jobId) {
      try { deleteJob(jobId); } catch { /* clean files below */ }
    }
    await fsPromises.rm(finalJobDir ?? stagingDir, { recursive: true, force: true });
    throw error;
  } finally { reservation.release(); }
}
