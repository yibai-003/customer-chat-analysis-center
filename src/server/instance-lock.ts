import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export function describePortOwner(port: number): string {
  if (process.platform !== "win32") return "";
  try {
    const output = execFileSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    const line = output.split(/\r?\n/).find((entry) =>
      entry.includes(`:${port} `) && /LISTENING/i.test(entry));
    const pid = line?.trim().split(/\s+/).at(-1);
    if (!pid || !/^\d+$/.test(pid)) return "";
    const task = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
    });
    const name = /^"([^"]+)"/.exec(task.trim())?.[1];
    return name ? `${name}（PID ${pid}）` : `PID ${pid}`;
  } catch {
    return "";
  }
}

/** OS-owned loopback socket: automatically released on process crash, with no stale PID file. */
export async function acquireInstanceLock(databasePath: string) {
  const resolved = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const canonical = fs.existsSync(resolved) ? fs.realpathSync(resolved) : path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const port = 30000 + crypto.createHash("sha256").update(identity).digest().readUInt32BE(0) % 20000;
  const lock = net.createServer(socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      lock.once("error", reject);
      lock.listen({ host: "127.0.0.1", port, exclusive: true }, () => { lock.removeListener("error", reject); resolve(); });
    });
  } catch {
    lock.close();
    const owner = describePortOwner(port);
    const detail = owner
      ? `占用进程：${owner}。请确认它是另一个数据库实例还是无关软件。`
      : "请检查现有进程，确认它是另一个数据库实例还是无关软件。";
    throw new Error(`该数据库已有服务运行，或本机保护端口 ${port} 被占用。${detail}未修改数据库。`);
  }
  lock.unref();
  let closed = false;
  return { port, release: () => new Promise<void>(resolve => {
    if (closed) return resolve();
    closed = true; lock.close(() => resolve());
  }) };
}
