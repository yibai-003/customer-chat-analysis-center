import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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
    throw new Error(`该数据库已有服务运行，或本机保护端口 ${port} 被占用。请检查现有进程，未修改数据库。`);
  }
  lock.unref();
  let closed = false;
  return { port, release: () => new Promise<void>(resolve => {
    if (closed) return resolve();
    closed = true; lock.close(() => resolve());
  }) };
}
