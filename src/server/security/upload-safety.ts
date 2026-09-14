import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import multer from "multer";
import unzipper from "unzipper";
import { XMLValidator } from "fast-xml-parser";
import { config } from "../config";
import { UploadError } from "./upload-error";
import { diskReservations, reservedFileWriter } from "./disk-reservations";
export { UploadError } from "./upload-error";

export function requireDiskSpace(extraBytes = 0) {
  diskReservations.assertAvailable(extraBytes);
}
export const defaultXlsxLimits = { entries: 20000, entryBytes: 64 * 1048576, totalBytes: 1024 * 1048576, metadataBytes: 2 * 1048576, imageBytes: 32 * 1048576, totalImageBytes: 256 * 1048576, maxImagePixels: 100_000_000, timeoutMs: 120000 };

function imageDimensions(buffer: Buffer, name: string) {
  if (name.endsWith(".png")) {
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (name.endsWith(".gif")) {
    if (buffer.length < 10 || !/^(GIF8[79]a)/.test(buffer.toString("ascii", 0, 6))) return;
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) {
    if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return;
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1]; const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3 && length >= 7) return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 7) };
      if (length < 2) break; offset += 2 + length;
    }
  }
}

function crc32Update(crc: number, buffer: Buffer) {
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc >>> 0;
}

function relationshipTargets(xml: string, source: string) {
  const targets: string[] = [];
  const base = source.startsWith("_rels/") ? "" : source.replace(/(^|\/)\_rels\//, "/").replace(/\.rels$/i, "");
  for (const match of xml.matchAll(/<Relationship\b[^>]*Target="([^"]+)"[^>]*>/gi)) {
    const target = match[1];
    if (/^(?:https?:|file:|data:|\\\\)/i.test(target)) throw new UploadError("Excel 关系文件包含外部资源", 415);
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(base), target));
    if (resolved.startsWith("../") || resolved === ".." || resolved.startsWith("/") || resolved.includes("\\")) throw new UploadError("Excel 关系文件路径越界", 415);
    targets.push(resolved);
  }
  return targets;
}

/** Scan a local immutable upload in bounded streams before handing it to a parser. */
export async function validateXlsx(filePath: string, filename: string, limits = defaultXlsxLimits) {
  if (!filename.toLowerCase().endsWith(".xlsx")) throw new UploadError("请上传 .xlsx 文件", 415);
  const handle = await fsp.open(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    if (bytesRead !== 4 || !header.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new UploadError("文件不是有效的 XLSX 压缩包", 415);
    // Check entry count/central directory size BEFORE unzipper builds an in-memory directory.
    const size = (await handle.stat()).size;
    const tail = Buffer.alloc(Math.min(size, 65557));
    await handle.read(tail, 0, tail.length, size - tail.length);
    const end = tail.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
    if (end < 0 || end + 22 > tail.length || end + 22 + tail.readUInt16LE(end + 20) !== tail.length) throw new UploadError("XLSX 文件尾损坏或不完整", 415);
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || count === 65535 || directorySize === 0xffffffff) throw new UploadError("暂不支持分卷或 ZIP64 文件，请拆分 Excel 后导入", 415);
    if (count > limits.entries || directorySize > 16 * 1048576) throw new UploadError("Excel 内部文件数量或目录过大，请拆分文件", 413);
  } finally { await handle.close(); }
  try {
    const directory = await unzipper.Open.file(filePath);
    if (directory.files.length > limits.entries) throw new UploadError("Excel 内部文件数量超过限制", 413);
    const required = new Set(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"]);
    const names = new Set<string>();
    const relationshipEntries: Array<{ name: string; xml: string }> = [];
    let imageBytes = 0;
    let declared = 0;
    for (const entry of directory.files) {
      const name = entry.path;
      if (name.includes("\\") || name.includes(":") || name.startsWith("/") || name.includes("\0") || name.split("/").includes("..") || names.has(name)) throw new UploadError("Excel 包含不安全或重复的文件路径", 415);
      names.add(name);
      if (entry.flags & 1 || ![0,8].includes(entry.compressionMethod)) throw new UploadError("不支持加密或特殊压缩方式的 Excel", 415);
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > limits.entryBytes) throw new UploadError("Excel 单个内部文件过大，请拆分后导入", 413);
      declared += entry.uncompressedSize;
      if (declared > limits.totalBytes) throw new UploadError("Excel 解压后大小超过限制", 413);
    }
    for (const name of required) if (!names.has(name)) throw new UploadError(`Excel 缺少必要结构：${name}`, 415);
    requireDiskSpace(declared);
    let total = 0;
    const expires = Date.now() + limits.timeoutMs;
    for (const entry of directory.files) {
      if (entry.type === "Directory") continue;
      if (Date.now() >= expires) throw new UploadError("Excel 安全检查超时，请拆分文件", 413);
      const stream = entry.stream();
      const timer = setTimeout(() => stream.destroy(new UploadError("Excel 安全检查超时", 413)), Math.max(1, expires - Date.now()));
      let bytes = 0;
      let checksum = 0xffffffff;
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of stream) {
          bytes += chunk.length; total += chunk.length;
          checksum = crc32Update(checksum, Buffer.from(chunk));
          if (bytes > limits.entryBytes || total > limits.totalBytes || (required.has(entry.path) && bytes > limits.metadataBytes)) throw new UploadError("Excel 实际解压数据超过限制", 413);
          if (required.has(entry.path) || /\.rels$/i.test(entry.path) || /^xl\/media\//i.test(entry.path)) chunks.push(Buffer.from(chunk));
        }
        if (bytes !== entry.uncompressedSize) throw new UploadError("Excel 内部文件长度不一致", 415);
        if (entry.crc32 !== undefined && ((checksum ^ 0xffffffff) >>> 0) !== Number(entry.crc32 >>> 0)) throw new UploadError("Excel 内部文件校验失败", 415);
        if (required.has(entry.path)) {
          const xml = Buffer.concat(chunks).toString("utf8");
          if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new UploadError("Excel 核心 XML 结构无效", 415);
        }
        if (/^xl\/media\//i.test(entry.path)) {
          imageBytes += bytes;
          if (bytes > limits.imageBytes || imageBytes > limits.totalImageBytes) throw new UploadError("Excel 图片资源超过限制", 413);
          const dimensions = imageDimensions(Buffer.concat(chunks), entry.path.toLowerCase());
          if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > limits.maxImagePixels) throw new UploadError("Excel 图片尺寸无效或像素过大", 413);
        }
        if (/\.rels$/i.test(entry.path)) relationshipEntries.push({ name: entry.path, xml: Buffer.concat(chunks).toString("utf8") });
      } finally { clearTimeout(timer); stream.destroy(); }
    }
    const allNames = names;
    for (const relation of relationshipEntries) for (const target of relationshipTargets(relation.xml, relation.name)) if (!allNames.has(target)) throw new UploadError("Excel 关系文件引用了不存在的资源", 415);
    return { entries: directory.files.length, expandedBytes: total };
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError("Excel 压缩包损坏或无法解析", 415);
  }
}

export function createSafeUpload() {
  const root = path.join(config.dataDir, "uploads");
  fs.mkdirSync(root, { recursive: true });
  const storage: multer.StorageEngine = {
    _handleFile(req, file, callback) {
      const target = path.join(root, crypto.randomUUID());
      const limit = config.maxUploadMb * 1048576;
      const contentLength = Number(req.headers["content-length"]);
      const estimate = Number.isSafeInteger(contentLength) && contentLength > 0 ? Math.min(contentLength, limit) : limit;
      let reservation: ReturnType<typeof diskReservations.reserve>;
      try { reservation = diskReservations.reserve(estimate); } catch (error) { callback(error); return; }
      void (async () => {
        const abort = () => file.stream.destroy(new Error("上传连接已中断"));
        req.once("aborted", abort);
        try {
          if (req.aborted) throw new Error("上传连接已中断");
          await pipeline(file.stream, reservedFileWriter(target, reservation));
          return { path: target, size: (await fsp.stat(target)).size, filename: path.basename(target), destination: root };
        } catch (error) { await fsp.rm(target, { force: true }).catch(() => undefined); throw error; }
        finally { req.removeListener("aborted", abort); reservation.release(); }
      })().then(info => callback(null, info), error => callback(error));
    },
    _removeFile(_req, file, callback) { fs.unlink(file.path, callback); },
  };
  return multer({ storage, limits: { fileSize: config.maxUploadMb * 1048576, files: 1, fields: 20, fieldSize: 1048576 } });
}
