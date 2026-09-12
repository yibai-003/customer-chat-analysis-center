import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { db, initDb } from "./db/client";
import { KnowledgeSync } from "./services/knowledge/knowledge-sync-service";

initDb({ preserveConfiguration: true });
const backupRoot = path.join(config.dataDir, "backups");
fs.mkdirSync(backupRoot, { recursive: true });
const target = path.join(backupRoot, `manual-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
db.prepare("VACUUM INTO ?").run(target);
const sync = new KnowledgeSync();
sync.export();
const keep = Math.max(1, Number(process.env.BACKUP_RETENTION ?? 7));
const backups = fs.readdirSync(backupRoot)
  .filter((name) => name.toLowerCase().endsWith(".db"))
  .map((name) => ({ name, path: path.join(backupRoot, name), time: fs.statSync(path.join(backupRoot, name)).mtimeMs }))
  .sort((a, b) => b.time - a.time);
for (const item of backups.slice(keep)) fs.rmSync(item.path, { force: true });
const integrity = db.pragma("integrity_check", { simple: true });
if (integrity !== "ok") throw new Error(`数据库完整性检查失败：${integrity}`);
console.log(JSON.stringify({ database: target, catalog: sync.file, retainedBackups: Math.min(keep, backups.length), integrity }, null, 2));
