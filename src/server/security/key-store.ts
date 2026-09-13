import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { assertNoLinks } from "./local-files";

/** Only for reading pre-migration data and isolated tests, never new installations. */
export const legacyEncryptionKey = "01234567890123456789012345678901";
export interface ManagedKey { version: 1; key: string; legacyMigrationPending: boolean }
export const managedKeyPath = (databasePath: string) => path.join(path.dirname(databasePath), ".secrets", `${path.basename(databasePath)}.key.json`);
export function externalEncryptionKey(value: string | undefined) {
  if (value === undefined || value === "replace-with-32-byte-base64-key") return undefined;
  if (value.length < 32 || value === legacyEncryptionKey) throw new Error("ENCRYPTION_KEY 必须是独立的至少 32 字符密钥；旧默认密钥请先迁移");
  return value;
}
function regular(file: string) {
  assertNoLinks(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error("本地密钥文件类型或大小无效");
}
export function readManagedKey(file: string): ManagedKey | undefined {
  assertNoLinks(file);
  if (!fs.existsSync(file)) return undefined;
  regular(file);
  let value: any;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("本地密钥文件无法解析；请恢复原密钥文件，不要删除后重新生成"); }
  if (value?.version !== 1 || typeof value.key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.key)
    || Buffer.from(value.key, "base64url").toString("base64url") !== value.key
    || typeof value.legacyMigrationPending !== "boolean") throw new Error("本地密钥文件格式无效");
  return { version: 1, key: value.key, legacyMigrationPending: value.legacyMigrationPending };
}
function restrict(file: string, directory = false) {
  if (process.platform === "win32") {
    const identity = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true, encoding: "utf8" });
    const sid = identity.match(/S-1-5-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw new Error("无法确定当前账户，未保存密钥");
    execFileSync("icacls.exe", [file, "/inheritance:r", "/grant:r", `*${sid}:${directory ? "(OI)(CI)" : ""}F`, `*S-1-5-18:${directory ? "(OI)(CI)" : ""}F`], { windowsHide: true, stdio: "pipe" });
  } else fs.chmodSync(file, directory ? 0o700 : 0o600);
}
export function writeManagedKey(file: string, value: ManagedKey, replace = false) {
  assertNoLinks(file);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  restrict(directory, true);
  if (fs.existsSync(file)) { regular(file); if (!replace) throw new Error("密钥文件已存在，拒绝覆盖"); }
  const temporary = path.join(directory, `.key-${crypto.randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600); restrict(temporary);
    fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    // The caller holds the database instance lock; a prepared key is durable before DB changes.
    fs.renameSync(temporary, file);
  } catch {
    throw new Error("安全保存本地密钥失败；数据库迁移未完成时请保留当前文件并重试");
  } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function newManagedKey(pending = false): ManagedKey {
  return { version: 1, key: crypto.randomBytes(32).toString("base64url"), legacyMigrationPending: pending };
}
export function runtimeEncryptionKey(file: string, external?: string) {
  const explicit = externalEncryptionKey(external);
  if (explicit) return explicit;
  const managed = readManagedKey(file);
  if (!managed || managed.legacyMigrationPending) throw new Error("本地加密密钥未就绪，请使用官方启动入口或完成 keys:migrate");
  return managed.key;
}
