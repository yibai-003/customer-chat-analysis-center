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
console.log(JSON.stringify({ database: target, catalog: sync.file }, null, 2));
