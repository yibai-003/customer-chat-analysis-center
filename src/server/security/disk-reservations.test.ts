import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import { DiskReservations, reservedFileWriter } from "./disk-reservations";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe("shared unwritten disk budget", () => {
  it("does not sell the same free bytes twice and credits completed writes without double counting", () => {
    let free = 1000;
    const pool = new DiskReservations(() => free, () => 100);
    const first = pool.reserve(600);
    expect(() => pool.reserve(301)).toThrow("预留");
    const second = pool.reserve(300); expect(pool.reservedBytes).toBe(900);
    free -= 200; first.consume(200);
    expect(pool.reservedBytes).toBe(700); expect(() => second.check(300)).not.toThrow();
    first.release(); first.release();
    expect(pool.reservedBytes).toBe(300); second.release(); expect(pool.activeReservations).toBe(0);
  });
  it("rechecks external disk consumption and fails closed on unavailable disk statistics", () => {
    let free = 1000; const pool = new DiskReservations(() => free, () => 100); const lease = pool.reserve(500);
    free = 599; expect(() => lease.check(1)).toThrow("磁盘空间不足"); lease.release();
    expect(() => new DiskReservations(() => { throw new Error("permission"); }, () => 100).reserve(1)).toThrow("无法检查");
  });
  it.each([-1, NaN, Infinity, 0.5])("rejects invalid sizes %s without acquiring a lease", value => {
    const pool = new DiskReservations(() => 1000, () => 100);
    expect(() => pool.reserve(value)).toThrow(); expect(pool.activeReservations).toBe(0);
  });
  it("writes using one reservation and refuses actual bytes beyond it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "disk-budget-")); roots.push(root);
    const pool = new DiskReservations(() => 1000, () => 100); const lease = pool.reserve(6);
    try {
      await pipeline(Readable.from([Buffer.from("abc"), Buffer.from("def")]), reservedFileWriter(path.join(root, "valid"), lease));
      expect(fs.readFileSync(path.join(root, "valid"), "utf8")).toBe("abcdef"); expect(pool.reservedBytes).toBe(0);
      await expect(pipeline(Readable.from([Buffer.from("x")]), reservedFileWriter(path.join(root, "overflow"), lease))).rejects.toMatchObject({ status: 413 });
    } finally { lease.release(); }
    expect(pool.activeReservations).toBe(0);
  });
});
