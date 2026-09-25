import fs from "node:fs";
import { Writable } from "node:stream";
import { config } from "../config";
import { UploadError } from "./upload-error";

export interface DiskReservation {
  check: (bytes: number) => void;
  consume: (bytes: number) => void;
  release: () => void;
}
const validBytes = (bytes: number) => Number.isSafeInteger(bytes) && bytes >= 0;
/** Remaining unwritten bytes, shared by all cooperating writers in this server process. */
export class DiskReservations {
  private leases = new Map<symbol, number>();
  constructor(private readonly available: () => number, private readonly minimum: () => number) {}
  get reservedBytes() { return [...this.leases.values()].reduce((sum, size) => sum + size, 0); }
  get activeReservations() { return this.leases.size; }
  assertAvailable(extraBytes = 0) {
    if (!validBytes(extraBytes)) throw new UploadError("磁盘预算字节数无效", 413);
    let free: number;
    try { free = this.available(); }
    catch { throw new UploadError("无法检查数据目录磁盘空间，请检查磁盘权限后重试", 503); }
    const minimum = this.minimum();
    if (!Number.isFinite(free) || free < 0 || !Number.isFinite(minimum) || minimum < 0) throw new UploadError("磁盘空间检测结果无效", 503);
    if (free - minimum - this.reservedBytes < extraBytes) throw new UploadError("磁盘空间不足，或可用空间已由其他上传/导入预留，请稍后重试", 507);
  }
  reserve(bytes: number): DiskReservation {
    this.assertAvailable(bytes);
    const id = Symbol(); this.leases.set(id, bytes);
    const checkCount = (count: number) => {
      const remaining = this.leases.get(id);
      if (!validBytes(count) || remaining === undefined || count > remaining) throw new UploadError("实际写入超过预留的磁盘预算", 413);
      return remaining;
    };
    return {
      check: count => { checkCount(count); this.assertAvailable(); },
      consume: count => { this.leases.set(id, checkCount(count) - count); },
      release: () => { this.leases.delete(id); },
    };
  }
}
export const diskReservations = new DiskReservations(() => {
  const stats = fs.statfsSync(config.dataDir);
  return stats.bavail * stats.bsize;
}, () => config.minFreeDiskMb * 1048576);

/** Debit only after actual write completion; pipeline destruction waits for the file to close. */
export function reservedFileWriter(file: string, reservation: DiskReservation) {
  const fd = fs.openSync(file, "wx");
  let writing = false;
  let pendingClose: (() => void) | undefined;
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try { reservation.check(chunk.length); } catch (error) { callback(error as Error); return; }
      writing = true;
      const finish = (error?: Error | null) => { writing = false; callback(error); pendingClose?.(); pendingClose = undefined; };
      let offset = 0;
      const write = () => fs.write(fd, chunk, offset, chunk.length - offset, null, (error, written) => {
        if (error) { finish(error); return; }
        if (stream.destroyed) { finish(new Error("磁盘写入已中止")); return; }
        if (!written) { finish(new Error("磁盘写入未取得进展")); return; }
        offset += written;
        if (offset < chunk.length) { write(); return; }
        try { reservation.consume(chunk.length); finish(); } catch (consumeError) { finish(consumeError as Error); }
      });
      if (chunk.length === 0) finish(); else write();
    },
    destroy(error, callback) {
      const close = () => fs.close(fd, closeError => callback(error ?? closeError));
      if (writing) pendingClose = close; else close();
    },
  });
  return stream;
}
