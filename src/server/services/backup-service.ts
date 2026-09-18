import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";

const referenceSchema = z.object({ table: z.enum(["jobs", "records", "import_jobs", "knowledge_imports"]), id: z.string(), column: z.enum(["source_path", "image_path"]), file: z.string() }).strict();
const exportSchema = z.object({ file: z.string(), name: z.string() }).strict();
const manifestSchema = z.object({
  version: z.literal(1), kind: z.literal("full"), createdAt: z.string().datetime(),
  files: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  references: z.array(referenceSchema),
  exports: z.array(exportSchema).default([]),
}).strict();
type Reference = z.infer<typeof referenceSchema>;
type Manifest = z.infer<typeof manifestSchema>;
const references = [{ table: "jobs", column: "source_path" }, { table: "records", column: "image_path" }, { table: "import_jobs", column: "source_path" }, { table: "knowledge_imports", column: "source_path" }] as const;

export function positiveInteger(value: unknown, name: string, fallback: number, max = 365) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error(`${name} must be an integer from 1 to ${max}`);
  return result;
}
function rejectLinks(file: string) {
  let current = path.resolve(file);
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function member(root: string, relative: string) {
  if (!relative || relative.includes("\\") || relative.split("/").some(p => !p || p === "." || p === "..") || path.isAbsolute(relative) || relative.includes(":")) throw new Error("Invalid backup member path");
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error("Backup path escapes directory");
  rejectLinks(file);
  return file;
}
async function hashFile(file: string) {
  rejectLinks(file);
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw new Error("Expected a regular backup file");
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return { size: stat.size, sha256: hash.digest("hex") };
}
function validateDatabase(database: any) {
  if (database.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Backup database integrity check failed");
  if (database.pragma("foreign_key_check").length) throw new Error("Backup database foreign key check failed");
}
function databaseReferences(database: any) {
  const result: Array<Reference & { original: string }> = [];
  for (const { table, column } of references) {
    for (const row of database.prepare(`SELECT id, ${column} AS file FROM ${table}`).all() as { id: string; file: string }[]) {
      // Finished/failed import bookkeeping can refer to deliberately removed staging files.
      if (table === "import_jobs" && !fs.existsSync(row.file)) {
        const status = database.prepare("SELECT status FROM import_jobs WHERE id=?").get(row.id).status;
        if (["completed", "failed", "cancelled"].includes(status)) continue;
      }
      result.push({ table, column, id: row.id, file: "", original: path.resolve(row.file) });
    }
  }
  return result;
}
export async function verifyBackup(directory: string): Promise<Manifest> {
  rejectLinks(directory);
  const manifest = manifestSchema.parse(JSON.parse(await fsp.readFile(member(directory, "manifest.json"), "utf8")));
  const entries = new Map(manifest.files.map(f => [f.path, f]));
  if (entries.size !== manifest.files.length || !entries.has("database.db") || !entries.has("knowledge/catalog.json")) throw new Error("Incomplete backup manifest");
  for (const file of manifest.files) {
    const actual = await hashFile(member(directory, file.path));
    if (actual.size !== file.size || actual.sha256 !== file.sha256) throw new Error(`Backup checksum mismatch: ${file.path}`);
  }
  const exportNames = new Set<string>();
  for (const item of manifest.exports) {
    if (!item.name || path.basename(item.name) !== item.name) throw new Error("Invalid export member name");
    if (exportNames.has(item.name)) throw new Error("Duplicate export member name");
    if (!entries.has(item.file)) throw new Error("Incomplete backup manifest");
    exportNames.add(item.name);
  }
  const database = new Database(member(directory, "database.db"), { readonly: true, fileMustExist: true });
  try {
    validateDatabase(database);
    const seen = new Set<string>();
    for (const ref of manifest.references) {
      const expectedColumn = ref.table === "records" ? "image_path" : "source_path";
      if (ref.column !== expectedColumn || !ref.file.startsWith("files/") || !entries.has(ref.file)) throw new Error("Invalid file reference");
      const key = `${ref.table}:${ref.id}`;
      if (seen.has(key) || !database.prepare(`SELECT id FROM ${ref.table} WHERE id=?`).get(ref.id)) throw new Error("Invalid or duplicate database reference");
      seen.add(key);
    }
    for (const table of ["jobs", "records", "knowledge_imports"] as const) {
      for (const row of database.prepare(`SELECT id FROM ${table}`).all()) if (!seen.has(`${table}:${row.id}`)) throw new Error(`Missing file reference in ${table}`);
    }
  } finally { database.close(); }
  return manifest;
}

export async function createFullBackup(options: {
  database: any; backupRoot: string; retention?: number;
  catalog: (database: any) => unknown;
  exportsDir?: string;
}) {
  positiveInteger(options.retention, "BACKUP_RETENTION", 7);
  rejectLinks(options.backupRoot);
  await fsp.mkdir(options.backupRoot, { recursive: true });
  const lock = path.join(options.backupRoot, ".backup.lock");
  const handle = await fsp.open(lock, "wx");
  try { await handle.writeFile(String(process.pid)); return await createFullBackupLocked(options); }
  finally { await handle.close(); await fsp.unlink(lock); }
}

async function createFullBackupLocked(options: { database: any; backupRoot: string; retention?: number; catalog: (database: any) => unknown; exportsDir?: string }) {
  const retention = positiveInteger(options.retention, "BACKUP_RETENTION", 7);
  rejectLinks(options.backupRoot);
  await fsp.mkdir(options.backupRoot, { recursive: true });
  const staging = await fsp.mkdtemp(path.join(options.backupRoot, ".partial-"));
  const createdAt = new Date().toISOString();
  const directory = path.join(options.backupRoot, `full-${createdAt.replace(/[:.]/g, "-")}-${crypto.randomUUID()}`);
  try {
    await options.database.backup(path.join(staging, "database.db"));
    const snapshot = new Database(path.join(staging, "database.db"), { readonly: true, fileMustExist: true });
    let refs: ReturnType<typeof databaseReferences>;
    let catalog: unknown;
    try { validateDatabase(snapshot); refs = databaseReferences(snapshot); catalog = options.catalog(snapshot); }
    finally { snapshot.close(); }
    await fsp.mkdir(path.join(staging, "knowledge"));
    await fsp.mkdir(path.join(staging, "files"));
    await fsp.writeFile(path.join(staging, "knowledge/catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
    const copied = new Map<string, string>();
    const mapped: Reference[] = [];
    for (const ref of refs!) {
      let file = copied.get(ref.original);
      if (!file) {
        file = `files/${crypto.randomUUID()}${path.extname(ref.original).replace(/[^.a-z0-9]/gi, "")}`;
        const before = await hashFile(ref.original);
        await fsp.copyFile(ref.original, member(staging, file));
        const copy = await hashFile(member(staging, file));
        const after = await hashFile(ref.original);
        if (copy.sha256 !== before.sha256 || copy.sha256 !== after.sha256) throw new Error("Source file changed during backup; retry later");
        copied.set(ref.original, file);
      }
      mapped.push({ table: ref.table, id: ref.id, column: ref.column, file });
    }
    // Generated exports are derived from the database but are kept so a restored
    // environment can serve previously delivered result workbooks without re-exporting.
    const exportMembers: Array<{ file: string; name: string }> = [];
    const exportFiles: string[] = [];
    if (options.exportsDir && fs.existsSync(options.exportsDir)) {
      rejectLinks(options.exportsDir);
      for (const entry of await fsp.readdir(options.exportsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const name = entry.name;
        if (!name || path.basename(name) !== name) continue;
        const source = path.join(options.exportsDir, name);
        const file = `files/${crypto.randomUUID()}${path.extname(name).replace(/[^.a-z0-9]/gi, "")}`;
        const before = await hashFile(source);
        await fsp.copyFile(source, member(staging, file));
        const copy = await hashFile(member(staging, file));
        if (copy.sha256 !== before.sha256) throw new Error("Export file changed during backup; retry later");
        exportMembers.push({ file, name });
        exportFiles.push(file);
      }
    }
    const files = [];
    for (const file of ["database.db", "knowledge/catalog.json", ...copied.values(), ...exportFiles]) files.push({ path: file, ...await hashFile(member(staging, file)) });
    const manifest: Manifest = { version: 1, kind: "full", createdAt, files, references: mapped, exports: exportMembers };
    await fsp.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
    await verifyBackup(staging);
    await fsp.rename(staging, directory);
    const warnings: string[] = [];
    // Only complete, verified packages generated here are retention candidates. Legacy/protected DBs remain intact.
    const valid: Array<{ directory: string; date: string }> = [];
    for (const entry of await fsp.readdir(options.backupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("full-")) continue;
      const candidate = path.join(options.backupRoot, entry.name);
      try { const checked = await verifyBackup(candidate); valid.push({ directory: candidate, date: checked.createdAt }); }
      catch { warnings.push(`Unverified backup retained: ${entry.name}`); }
    }
    valid.sort((a, b) => b.date.localeCompare(a.date));
    for (const old of valid.slice(retention)) {
      if (old.directory === directory) continue;
      try { rejectLinks(old.directory); await fsp.rm(old.directory, { recursive: true }); }
      catch { warnings.push(`Old backup could not be removed: ${path.basename(old.directory)}`); }
    }
    return { directory, files: files.length, references: mapped.length, verified: true, warnings };
  } catch (error) {
    // This directory was created by this invocation and has never been promoted to a backup.
    await fsp.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Restore into a NEW recovery directory. Never overwrite a running/existing environment. */
export async function restoreFullBackup(source: string, target: string) {
  const manifest = await verifyBackup(source);
  target = path.resolve(target);
  rejectLinks(target);
  if (fs.existsSync(target)) throw new Error("Recovery directory already exists; choose a new directory");
  if (target.startsWith(path.resolve(source) + path.sep)) throw new Error("Recovery directory must be outside the backup");
  await fsp.mkdir(path.dirname(target), { recursive: true });
  // Reserve destination so a second restore cannot replace it.
  await fsp.mkdir(target);
  try {
    await fsp.mkdir(path.join(target, "data"));
    await fsp.mkdir(path.join(target, "knowledge"));
    await fsp.copyFile(member(source, "database.db"), path.join(target, "data/app.db"));
    await fsp.copyFile(member(source, "knowledge/catalog.json"), path.join(target, "knowledge/catalog.json"));
    if ((await hashFile(path.join(target, "knowledge/catalog.json"))).sha256 !== manifest.files.find(f => f.path === "knowledge/catalog.json")!.sha256) throw new Error("Restored catalog checksum mismatch");
    const exportFiles = new Set(manifest.exports.map((item) => item.file));
    for (const file of manifest.files.filter(f => f.path.startsWith("files/") && !exportFiles.has(f.path))) {
      const dest = member(path.join(target, "data"), file.path);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(member(source, file.path), dest);
      if ((await hashFile(dest)).sha256 !== file.sha256) throw new Error("Restored file checksum mismatch");
    }
    for (const item of manifest.exports) {
      const dest = member(path.join(target, "data", "exports"), item.name);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(member(source, item.file), dest);
      if ((await hashFile(dest)).sha256 !== manifest.files.find(f => f.path === item.file)!.sha256) throw new Error("Restored export checksum mismatch");
    }
    if ((await hashFile(path.join(target, "data/app.db"))).sha256 !== manifest.files.find(f => f.path === "database.db")!.sha256) throw new Error("Restored database checksum mismatch");
    const database = new Database(path.join(target, "data/app.db"));
    try {
      database.pragma("foreign_keys = ON");
      database.transaction(() => {
        database.exec("UPDATE import_jobs SET source_path='';");
        for (const ref of manifest.references) database.prepare(`UPDATE ${ref.table} SET ${ref.column}=? WHERE id=?`)
          .run(member(path.join(target, "data"), ref.file), ref.id);
        database.exec("UPDATE records SET status='failed',review_status='needs_review' WHERE status='processing'; UPDATE jobs SET run_token=NULL, status=CASE WHEN status='processing' THEN 'failed' ELSE status END; UPDATE import_jobs SET status='failed',error_message='Interrupted before backup restore' WHERE status IN ('processing','queued');");
      })();
      validateDatabase(database);
    } finally { database.close(); }
    const catalogText = await fsp.readFile(path.join(target, "knowledge/catalog.json"), "utf8");
    const hash = crypto.createHash("sha256").update(catalogText).digest("hex");
    await fsp.writeFile(path.join(target, "data/knowledge-sync-state.json"), JSON.stringify({ hash }));
    await fsp.writeFile(path.join(target, "RESTORED.json"), JSON.stringify({ restoredAt: new Date().toISOString(), source: path.resolve(source), originalCreatedAt: manifest.createdAt, encryptionKey: "Restore the matching .secrets/<database-name>.key.json beside the database, or use the original ENCRYPTION_KEY. Keys are NOT included in this package." }, null, 2));
    return { directory: target, database: path.join(target, "data/app.db"), files: manifest.references.length, verified: true };
  } catch (error) {
    // Preserve failed recovery evidence; no change to the source backup/current application.
    await fsp.writeFile(path.join(target, "RESTORE_FAILED.txt"), "Restore failed. Do not start the application in this directory.\n").catch(() => undefined);
    throw error;
  }
}
