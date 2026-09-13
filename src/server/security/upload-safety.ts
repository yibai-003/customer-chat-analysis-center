import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import multer from "multer";
import unzipper from "unzipper";
import { XMLValidator } from "fast-xml-parser";
import { config } from "../config";

export class UploadError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export function requireDiskSpace(extraBytes = 0) {
  let stats: fs.StatsFs;
  try { stats = fs.statfsSync(config.dataDir); }
  catch { throw new UploadError("无法检查数据目录磁盘空间，请检查磁盘权限后重试", 503); }
  if (stats.bavail * stats.bsize < config.minFreeDiskMb * 1048576 + extraBytes) {
    throw new UploadError("磁盘空间不足，请清理空间或更换数据目录", 507);
  }
}
export const defaultXlsxLimits = { entries: 20000, entryBytes: 64 * 1048576, totalBytes: 1024 * 1048576, metadataBytes: 2 * 1048576, timeoutMs: 120000 };

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
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of stream) {
          bytes += chunk.length; total += chunk.length;
          if (bytes > limits.entryBytes || total > limits.totalBytes || (required.has(entry.path) && bytes > limits.metadataBytes)) throw new UploadError("Excel 实际解压数据超过限制", 413);
          if (required.has(entry.path)) chunks.push(Buffer.from(chunk));
        }
        if (bytes !== entry.uncompressedSize) throw new UploadError("Excel 内部文件长度不一致", 415);
        if (required.has(entry.path)) {
          const xml = Buffer.concat(chunks).toString("utf8");
          if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new UploadError("Excel 核心 XML 结构无效", 415);
        }
      } finally { clearTimeout(timer); stream.destroy(); }
    }
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
    _handleFile(_req, file, callback) {
      const target = path.join(root, crypto.randomUUID());
      let size = 0;
      let nextCheck = 0;
      const guard = new Transform({ transform(chunk, _encoding, done) {
        try {
          if (size >= nextCheck) { requireDiskSpace(chunk.length + 1048576); nextCheck = size + 1048576; }
          size += chunk.length; done(null, chunk);
        } catch (e) { done(e as Error); }
      } });
      void pipeline(file.stream, guard, fs.createWriteStream(target, { flags: "wx" }))
        .then(() => callback(null, { path: target, size, filename: path.basename(target), destination: root }))
        .catch(async error => { await fsp.rm(target, { force: true }).catch(() => undefined); callback(error); });
    },
    _removeFile(_req, file, callback) { fs.unlink(file.path, callback); },
  };
  return multer({ storage, limits: { fileSize: config.maxUploadMb * 1048576, files: 1, fields: 20, fieldSize: 1048576 } });
}
