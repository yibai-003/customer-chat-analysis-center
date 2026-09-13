import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { acquireInstanceLock } from "../instance-lock";
import { assertNoLinks, inside } from "../security/local-files";
import { appliedMigrations, currentSchemaVersion } from "../db/migrations";
import { positiveInteger } from "./backup-service";

const temporaryRoots = ["uploads", "knowledge-previews", "job-staging"];
const referenceColumns = [["jobs", "source_path"], ["records", "image_path"], ["import_jobs", "source_path"], ["knowledge_imports", "source_path"]];
const identity = (file: string) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);

export async function maintainFiles(options: { databasePath: string; dataDir: string; projectRoot: string; days?: number; apply?: boolean; now?: number }) {
  const days = positiveInteger(options.days, "CLEANUP_RETENTION_DAYS", 14, 3650);
  const cutoff = (options.now ?? Date.now()) - days * 86_400_000;
  const dataDir = path.resolve(options.dataDir);
  assertNoLinks(dataDir);
  assertNoLinks(options.databasePath);
  if (!fs.existsSync(options.databasePath)) throw new Error("数据库不存在；未创建或迁移数据库");
  const lock = options.apply ? await acquireInstanceLock(options.databasePath) : undefined;
  let database: any;
  try {
    database = new Database(options.databasePath, { readonly: true, fileMustExist: true });
    if (appliedMigrations(database).at(-1)?.version !== currentSchemaVersion) throw new Error("数据库版本不匹配；请先正常启动完成升级，再停止服务清理");
    if (database.pragma("integrity_check", { simple: true }) !== "ok" || database.pragma("foreign_key_check").length) throw new Error("数据库校验失败，停止清理");
    return database.transaction(() => {
      const busy = Boolean(database.prepare("SELECT id FROM jobs WHERE run_token IS NOT NULL OR status='processing' LIMIT 1").get()
        || database.prepare("SELECT id FROM records WHERE status='processing' LIMIT 1").get()
        || database.prepare("SELECT id FROM import_jobs WHERE status IN ('queued','processing') LIMIT 1").get()
        || database.prepare("SELECT id FROM knowledge_imports WHERE status IN ('queued','processing') LIMIT 1").get());
      if (busy && options.apply) throw new Error("存在运行中或未恢复的任务；请先启动服务完成恢复，再停止服务清理");
      const references = new Set<string>();
      for (const suffix of ["", "-wal", "-shm", "-journal"]) references.add(identity(options.databasePath + suffix));
      for (const [table, column] of referenceColumns) {
        for (const row of database.prepare(`SELECT ${column} AS file FROM ${table}`).iterate()) {
          if (!row.file) continue;
          const file = path.resolve(options.projectRoot, row.file);
          references.add(identity(file));
          try { references.add(identity(fs.realpathSync(file))); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
      }
      const candidates: { path: string; bytes: number; stat: fs.Stats }[] = [];
      const skipped = { referenced: 0, recent: 0, linksOrSpecial: 0 };
      let visited = 0;
      function scan(directory: string) {
        assertNoLinks(directory);
        if (!inside(dataDir, directory)) throw new Error("清理路径越界");
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory)) {
          if (++visited > 100_000) throw new Error("临时文件超过扫描上限；未执行清理");
          const file = path.join(directory, entry);
          const stat = fs.lstatSync(file);
          if (stat.isSymbolicLink()) { skipped.linksOrSpecial++; continue; }
          if (stat.isDirectory()) { scan(file); continue; }
          if (!stat.isFile() || stat.nlink > 1) { skipped.linksOrSpecial++; continue; }
          if (references.has(identity(file)) || references.has(identity(fs.realpathSync(file)))) { skipped.referenced++; continue; }
          if (stat.mtimeMs >= cutoff) { skipped.recent++; continue; }
          candidates.push({ path: file, bytes: stat.size, stat });
        }
      }
      for (const name of temporaryRoots) scan(path.join(dataDir, name));
      let removed = 0;
      if (options.apply) {
        for (const file of candidates) {
          assertNoLinks(file.path);
          if (!inside(dataDir, file.path)) throw new Error("清理路径越界");
          const current = fs.lstatSync(file.path);
          if (!current.isFile() || current.nlink > 1 || current.ino !== file.stat.ino || current.dev !== file.stat.dev
            || current.size !== file.bytes || current.mtimeMs !== file.stat.mtimeMs || current.ctimeMs !== file.stat.ctimeMs) throw new Error("文件在扫描后发生变化，已停止后续清理");
          fs.unlinkSync(file.path);
          removed++;
        }
      }
      return { mode: options.apply ? "apply" : "dry-run", retentionDays: days, integrity: "ok", busy, applyRequiresStoppedServer: true,
        candidates: candidates.map(({ path: file, bytes }) => ({ path: path.relative(dataDir, file), bytes })),
        candidateBytes: candidates.reduce((sum, file) => sum + file.bytes, 0), removed, skipped };
    })();
  } finally { database?.close(); await lock?.release(); }
}
