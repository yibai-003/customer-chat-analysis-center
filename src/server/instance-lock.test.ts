import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { acquireInstanceLock, describePortOwner } from "./instance-lock";

describe("process ownership", () => {
  it("reports the occupied port, the owning process and the next steps", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instance-conflict-"));
    const databasePath = path.join(dir, "app.db");
    const first = await acquireInstanceLock(databasePath);
    try {
      const failure = await acquireInstanceLock(databasePath).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain(String(first.port));
      expect(message).toContain("另一个数据库实例");
      expect(message).toContain("未修改数据库");
      if (process.platform === "win32") expect(message).toContain(String(process.pid));
    } finally {
      await first.release();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("identifies the process listening on a lock port", async () => {
    const server = net.createServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    try {
      const owner = describePortOwner(port);
      if (process.platform === "win32") {
        expect(owner).toContain(`PID ${process.pid}`);
      } else {
        expect(owner).toBe("");
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

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
