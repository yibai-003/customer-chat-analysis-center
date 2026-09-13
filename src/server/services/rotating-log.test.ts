import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RotatingLog } from "./rotating-log";
import { runLoggedProcess } from "./logged-process";
import { acquireInstanceLock } from "../instance-lock";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "rotating-log-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const log = (options: Partial<ConstructorParameters<typeof RotatingLog>[0]> = {}) => new RotatingLog({ directory: root, channel: "out", maxBytes: 8, retention: 3, ...options });
async function finish(stream: RotatingLog, data: string) { const done = finished(stream); stream.end(data); await done; }

describe("bounded process logs", () => {
  it("splits oversized writes without losing bytes and retains only the configured archive slots", async () => {
    const source = "abcdefghijklmnopqrstuvwxyz!";
    await finish(log(), source);
    const names = ["server.out.3.log", "server.out.2.log", "server.out.1.log", "server.out.log"];
    expect(names.map(name => fs.readFileSync(path.join(root, name), "utf8")).join("")).toBe(source);
    for (const name of names) expect(fs.statSync(path.join(root, name)).size).toBeLessThanOrEqual(8);
    fs.writeFileSync(path.join(root, "legacy.log"), "keep");
    await finish(log(), "x".repeat(100));
    expect(fs.readdirSync(root).filter(name => name.startsWith("server.out"))).toHaveLength(4);
    expect(fs.readFileSync(path.join(root, "legacy.log"), "utf8")).toBe("keep");
    await finish(log({ retention: 1 }), "y".repeat(20));
    expect(fs.readdirSync(root).filter(name => name.startsWith("server.out"))).toHaveLength(2);
  });
  it("appends on restart and rolls on the next UTC day", async () => {
    await finish(log({ maxBytes: 100 }), "before");
    await finish(log({ maxBytes: 100 }), "after");
    expect(fs.readFileSync(path.join(root, "server.out.log"), "utf8")).toBe("beforeafter");
    await finish(log({ maxBytes: 100, now: () => new Date(Date.now() + 86_400_000) }), "next day");
    expect(fs.readFileSync(path.join(root, "server.out.1.log"), "utf8")).toBe("beforeafter");
    expect(fs.readFileSync(path.join(root, "server.out.log"), "utf8")).toBe("next day");
  });
  it("refuses linked log files and archive destinations without touching the target", async () => {
    const external = path.join(root, "protected"); fs.writeFileSync(external, "keep");
    fs.linkSync(external, path.join(root, "server.out.log"));
    expect(() => log()).toThrow("regular file");
    fs.unlinkSync(path.join(root, "server.out.log"));
    fs.linkSync(external, path.join(root, "server.out.1.log"));
    await expect(finish(log(), "large enough to rotate")).rejects.toThrow("regular file");
    expect(fs.readFileSync(external, "utf8")).toBe("keep");
  });
  it("captures real stdout/stderr, drains the streams and preserves the child failure code", async () => {
    const code = await runLoggedProcess({ command: process.execPath,
      args: ["-e", "process.stdout.write('output'.repeat(100)); process.stderr.write('error'); process.exitCode=7"],
      cwd: root, logDir: root, maxBytes: 1024, retention: 2 });
    expect(code).toBe(7);
    expect(fs.readFileSync(path.join(root, "server.out.log"), "utf8")).toBe("output".repeat(100));
    expect(fs.readFileSync(path.join(root, "server.err.log"), "utf8")).toBe("error");
  });
  it("blocks another logger before opening or pruning logs", async () => {
    const lock = await acquireInstanceLock(path.join(root, ".log-owner"));
    try {
      await expect(runLoggedProcess({ command: process.execPath, args: ["-e", ""], cwd: root, logDir: root, maxBytes: 10, retention: 1 })).rejects.toThrow("已有服务");
      expect(fs.readdirSync(root)).toEqual([]);
    } finally { await lock.release(); }
  });
  it("reports spawn failures and releases the log lock", async () => {
    const options = { command: path.join(root, "missing-node.exe"), args: [], cwd: root, logDir: root, maxBytes: 10, retention: 1 };
    await expect(runLoggedProcess(options)).rejects.toThrow();
    const lock = await acquireInstanceLock(path.join(root, ".log-owner")); await lock.release();
  });
});
