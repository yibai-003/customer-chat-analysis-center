import fs from "node:fs/promises";
import path from "node:path";
import { positiveInteger, verifyBackup } from "./backup-service";

export function scheduleBackups(options: {
  root: string; hours?: number; create: () => Promise<unknown>; busy: () => boolean;
  log: (message: string) => void;
}) {
  const interval = positiveInteger(options.hours, "BACKUP_INTERVAL_HOURS", 24, 8760) * 3_600_000;
  let stopped = false;
  let running = false;
  let lastSuccess = 0;
  let initialized = false;
  const tick = async () => {
    if (stopped || running || options.busy()) return;
    running = true;
    try {
      if (!initialized) {
        const names = await fs.readdir(options.root).catch((e) => { if (e.code === "ENOENT") return []; throw e; });
        for (const name of names.filter(n => n.startsWith("full-")).sort().reverse()) {
          try { lastSuccess = Date.parse((await verifyBackup(path.join(options.root, name))).createdAt); break; }
          catch { /* damaged packages do not suppress a fresh backup */ }
        }
        initialized = true;
      }
      if (stopped || options.busy() || Date.now() - lastSuccess < interval) return;
      await options.create();
      lastSuccess = Date.now();
      options.log("完整备份已创建并验证");
    } catch (error) { options.log(`完整备份失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
