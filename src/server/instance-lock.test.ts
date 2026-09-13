import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { acquireInstanceLock } from "./instance-lock";

describe("process ownership", () => {
  it("blocks a second process for the same database and releases automatically on crash", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instance-ownership-"));
    const databasePath = path.join(dir, "app.db");
    let child: ChildProcess | undefined;
    let release: (() => Promise<void>) | undefined;
    try {
      const script = 'import { acquireInstanceLock } from "./src/server/instance-lock.ts"; await acquireInstanceLock(process.argv[1]); process.send?.("locked"); setInterval(()=>{},1000);';
      child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, databasePath], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Child lock timeout")), 8000);
        child!.once("message", () => { clearTimeout(timeout); resolve(); });
        child!.once("exit", () => { clearTimeout(timeout); reject(new Error("Child exited before acquiring lock")); });
      });
      await expect(acquireInstanceLock(databasePath)).rejects.toThrow("已有服务");
      expect(fs.existsSync(databasePath)).toBe(false);
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      const lock = await acquireInstanceLock(databasePath); release = lock.release;
      expect(lock.port).toBeGreaterThanOrEqual(30000);
    } finally {
      if (release) await release();
      if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 12000);
});
