import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { decryptSecret, encryptSecret } from "./secrets";
import { externalEncryptionKey, legacyEncryptionKey, managedKeyPath, newManagedKey, readManagedKey, writeManagedKey } from "./key-store";
import { assertNoLinks } from "./local-files";
import { acquireInstanceLock } from "../instance-lock";
import { appliedMigrations, currentSchemaVersion } from "../db/migrations";

type Options = { databasePath: string; externalKey?: string };
function rows(database: any): { id: string; ciphertext: string }[] {
  if (!database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_configs'").get()) return [];
  return database.prepare("SELECT id,api_key_ciphertext AS ciphertext FROM model_configs ORDER BY id").all();
}
function readable(values: ReturnType<typeof rows>, key: string) {
  try { for (const row of values) decryptSecret(row.ciphertext, key); return true; } catch { return false; }
}
function inspect(options: Options) {
  assertNoLinks(options.databasePath);
  if (!fs.existsSync(options.databasePath)) return [];
  const database = new Database(options.databasePath, { readonly: true, fileMustExist: true });
  try { return rows(database); } finally { database.close(); }
}
/** Called only after acquiring the server's exclusive database lock. */
export function initializeEncryptionKey(options: Options) {
  const values = inspect(options);
  const external = externalEncryptionKey(options.externalKey);
  if (external) {
    if (!readable(values, external)) throw new Error("配置的 ENCRYPTION_KEY 无法解密已有模型凭据，未更改数据");
    return;
  }
  const file = managedKeyPath(options.databasePath);
  const managed = readManagedKey(file);
  if (managed) {
    if (!readable(values, managed.key)) throw new Error(managed.legacyMigrationPending ? "密钥迁移尚未完成；停止服务后运行 npm run keys:migrate -- --apply" : "本地密钥与数据库不匹配；请恢复对应密钥，未更改数据");
    if (managed.legacyMigrationPending) writeManagedKey(file, { ...managed, legacyMigrationPending: false }, true);
    return;
  }
  if (values.length) throw new Error("已有模型凭据但未配置独立密钥；请停止服务后运行 npm run keys:migrate -- --apply，或恢复原密钥");
  writeManagedKey(file, newManagedKey());
}
export function encryptionStatus(options: Options) {
  const values = inspect(options);
  const external = externalEncryptionKey(options.externalKey);
  const managed = external ? undefined : readManagedKey(managedKeyPath(options.databasePath));
  const key = external ?? managed?.key;
  return { source: external ? "environment" : managed ? "managed-file" : "unconfigured", models: values.length,
    decryptable: key ? readable(values, key) : values.length === 0,
    pending: managed?.legacyMigrationPending ?? false,
    legacyMigrationAvailable: !external && (!managed || managed.legacyMigrationPending) && readable(values, legacyEncryptionKey),
    keyFile: managedKeyPath(options.databasePath) };
}
/** Migrate the historical built-in key. External custom keys remain externally managed. */
export async function migrateLegacyKey(options: Options) {
  if (externalEncryptionKey(options.externalKey)) throw new Error("当前使用独立环境密钥；无需默认密钥迁移，请继续单独保管原 ENCRYPTION_KEY");
  assertNoLinks(options.databasePath);
  if (!fs.existsSync(options.databasePath)) throw new Error("数据库不存在，请先正常启动以创建新环境");
  const lock = await acquireInstanceLock(options.databasePath);
  let database: any;
  try {
    database = new Database(options.databasePath, { fileMustExist: true });
    if (appliedMigrations(database).at(-1)?.version !== currentSchemaVersion) throw new Error("迁移前必须使用匹配的数据库版本");
    if (database.pragma("integrity_check", { simple: true }) !== "ok" || database.pragma("foreign_key_check").length) throw new Error("数据库校验失败，未迁移密钥");
    if (database.prepare("SELECT id FROM jobs WHERE run_token IS NOT NULL OR status='processing' LIMIT 1").get()
      || database.prepare("SELECT id FROM records WHERE status='processing' LIMIT 1").get()
      || database.prepare("SELECT id FROM import_jobs WHERE status IN ('queued','processing') LIMIT 1").get()
      || database.prepare("SELECT id FROM knowledge_imports WHERE status IN ('queued','processing') LIMIT 1").get()) throw new Error("存在未恢复任务，先完成任务恢复再离线迁移");
    const values = rows(database);
    const file = managedKeyPath(options.databasePath);
    let managed = readManagedKey(file);
    if (managed && readable(values, managed.key)) {
      if (managed.legacyMigrationPending) writeManagedKey(file, { ...managed, legacyMigrationPending: false }, true);
      return { state: "already-migrated", models: values.length, verified: true, keyFile: file };
    }
    if (managed && !managed.legacyMigrationPending) throw new Error("现有密钥与数据库不匹配，拒绝覆盖密钥");
    if (!readable(values, legacyEncryptionKey)) throw new Error("旧默认密钥无法解密全部模型凭据；请恢复正确密钥或损坏数据，未修改数据库");
    const backupDir = path.join(path.dirname(options.databasePath), "backups", "key-migrations");
    assertNoLinks(backupDir); fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, `before-key-${Date.now()}-${crypto.randomUUID()}.db`);
    await database.backup(backup);
    const copy = new Database(backup, { readonly: true, fileMustExist: true });
    try {
      if (copy.pragma("integrity_check", { simple: true }) !== "ok" || copy.pragma("foreign_key_check").length
        || JSON.stringify(rows(copy)) !== JSON.stringify(values) || !readable(rows(copy), legacyEncryptionKey)) throw new Error("迁移前保护备份校验失败");
    } finally { copy.close(); }
    if (!managed) { managed = newManagedKey(true); writeManagedKey(file, managed); }
    const targetKey = managed.key;
    database.transaction(() => {
      if (JSON.stringify(rows(database)) !== JSON.stringify(values)) throw new Error("备份后模型配置发生变化，停止迁移");
      for (const row of values) {
        const plaintext = decryptSecret(row.ciphertext, legacyEncryptionKey);
        const ciphertext = encryptSecret(plaintext, targetKey);
        if (decryptSecret(ciphertext, targetKey) !== plaintext) throw new Error("新密钥往返校验失败");
        database.prepare("UPDATE model_configs SET api_key_ciphertext=? WHERE id=?").run(ciphertext, row.id);
      }
      if (!readable(rows(database), targetKey)) throw new Error("迁移结果解密校验失败");
    })();
    writeManagedKey(file, { ...managed, legacyMigrationPending: false }, true);
    return { state: "migrated", models: values.length, verified: true, keyFile: file, backup };
  } finally { database?.close(); await lock.release(); }
}
