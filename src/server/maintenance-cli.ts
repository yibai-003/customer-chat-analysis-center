import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { db, initDb } from "./db/client";

initDb({ preserveConfiguration: true });
const days = Math.max(1, Number(process.env.CLEANUP_RETENTION_DAYS ?? 14));
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
const roots = [
  path.join(config.dataDir, "knowledge-previews"),
  path.join(config.dataDir, "uploads"),
  path.join(config.dataDir, "logs"),
];
let removed = 0;
for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const stat = fs.statSync(target);
    if (stat.mtimeMs < cutoff) {
      fs.rmSync(target, { recursive: entry.isDirectory(), force: true });
      removed += 1;
    }
  }
}
const integrity = db.pragma("integrity_check", { simple: true });
if (integrity !== "ok") throw new Error(`数据库完整性检查失败：${integrity}`);
console.log(JSON.stringify({ retentionDays: days, removed, integrity }, null, 2));
