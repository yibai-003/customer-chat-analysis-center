import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { assertNoLinks } from "../security/local-files";

export class RotatingLog extends Writable {
  private fd: number | undefined;
  private bytes = 0;
  private day = "";
  private readonly file: string;
  constructor(private readonly options: {
    directory: string; channel: "out" | "err"; maxBytes: number; retention: number;
    now?: () => Date; mirror?: Writable;
  }) {
    super();
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1
      || !Number.isSafeInteger(options.retention) || options.retention < 1 || options.retention > 30) throw new Error("Invalid log rotation limits");
    this.file = path.join(options.directory, `server.${options.channel}.log`);
    assertNoLinks(options.directory);
    fs.mkdirSync(options.directory, { recursive: true });
    this.open();
  }
  private regular(file: string) {
    assertNoLinks(file);
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.nlink > 1) throw new Error("Log path must be an unlinked regular file");
    }
  }
  private open() {
    this.regular(this.file);
    this.fd = fs.openSync(this.file, "a");
    const stat = fs.fstatSync(this.fd);
    this.bytes = stat.size;
    this.day = stat.mtime.toISOString().slice(0, 10);
  }
  private rotate() {
    const archive = (n: number) => path.join(this.options.directory, `server.${this.options.channel}.${n}.log`);
    this.regular(this.file);
    for (let n = 1; n <= 30; n++) this.regular(archive(n));
    if (this.fd !== undefined) { fs.closeSync(this.fd); this.fd = undefined; }
    for (let n = this.options.retention; n <= 30; n++) {
      if (fs.existsSync(archive(n))) fs.unlinkSync(archive(n));
    }
    for (let n = this.options.retention - 1; n >= 1; n--) {
      if (fs.existsSync(archive(n))) fs.renameSync(archive(n), archive(n + 1));
    }
    fs.renameSync(this.file, archive(1));
    this.open();
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    try {
      const day = (this.options.now?.() ?? new Date()).toISOString().slice(0, 10);
      let offset = 0;
      while (offset < chunk.length) {
        if (this.bytes > 0 && (this.day !== day || this.bytes >= this.options.maxBytes)) this.rotate();
        this.day = day;
        const length = Math.min(chunk.length - offset, this.options.maxBytes - this.bytes);
        const written = fs.writeSync(this.fd!, chunk, offset, length);
        if (!written) throw new Error("Unable to write server log");
        offset += written; this.bytes += written;
      }
      if (this.options.mirror) this.options.mirror.write(chunk, callback);
      else callback();
    } catch (error) { callback(error as Error); }
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    try { if (this.fd !== undefined) fs.closeSync(this.fd); this.fd = undefined; callback(error); }
    catch (closeError) { callback(error ?? closeError as Error); }
  }
}
