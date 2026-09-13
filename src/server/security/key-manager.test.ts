import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrations";
import { acquireInstanceLock } from "../instance-lock";
import { decryptSecret, encryptSecret } from "./secrets";
import { encryptionStatus, initializeEncryptionKey, migrateLegacyKey } from "./key-manager";
import { externalEncryptionKey, legacyEncryptionKey, managedKeyPath, newManagedKey, readManagedKey, runtimeEncryptionKey, writeManagedKey } from "./key-store";

let root: string;
let database: any;
let options: { databasePath: string };
const originalSecret = "sk-isolated-test-secret";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-key-"));
  options = { databasePath: path.join(root, "app.db") };
  database = new Database(options.databasePath); runMigrations(database);
});
afterEach(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
function addModel(id = "m1", key = legacyEncryptionKey) {
  database.prepare(`INSERT INTO model_configs(id,name,base_url,api_key_ciphertext,model,created_at,updated_at,capability_json,capability_checked_at)
    VALUES(?,?,'https://example.com',?,'test','now','now','{"text":true}',1234)`).run(id, id, encryptSecret(originalSecret, key));
}
const ciphertexts = () => database.prepare("SELECT id,api_key_ciphertext,capability_json,capability_checked_at,updated_at FROM model_configs ORDER BY id").all();

describe("managed key initialization and offline migration", () => {
  it("creates independent random keys for new databases and reuses the same key on restart", () => {
    initializeEncryptionKey(options);
    const first = readManagedKey(managedKeyPath(options.databasePath))!;
    expect(first.legacyMigrationPending).toBe(false); expect(first.key).not.toBe(legacyEncryptionKey);
    initializeEncryptionKey(options);
    expect(readManagedKey(managedKeyPath(options.databasePath))).toEqual(first);
    const other = { databasePath: path.join(root, "other.db") };
    initializeEncryptionKey(other);
    expect(readManagedKey(managedKeyPath(other.databasePath))!.key).not.toBe(first.key);
    expect(fs.existsSync(other.databasePath)).toBe(false);
  });
  it("refuses to generate a replacement for existing credentials, and status never returns secrets", () => {
    addModel();
    const before = ciphertexts();
    expect(() => initializeEncryptionKey(options)).toThrow("keys:migrate");
    expect(fs.existsSync(managedKeyPath(options.databasePath))).toBe(false);
    const status = encryptionStatus(options);
    expect(status).toMatchObject({ models: 1, legacyMigrationAvailable: true, decryptable: false });
    expect(JSON.stringify(status)).not.toContain(originalSecret);
    expect(ciphertexts()).toEqual(before);
  });
  it("backs up old ciphertext, transactionally re-encrypts every model, and is idempotent", async () => {
    addModel(); addModel("m2");
    const before = ciphertexts();
    const result = await migrateLegacyKey(options);
    expect(result).toMatchObject({ state: "migrated", models: 2, verified: true });
    const key = readManagedKey(managedKeyPath(options.databasePath))!;
    expect(key.legacyMigrationPending).toBe(false);
    for (const row of ciphertexts()) {
      expect(decryptSecret(row.api_key_ciphertext, key.key)).toBe(originalSecret);
      expect(() => decryptSecret(row.api_key_ciphertext, legacyEncryptionKey)).toThrow();
      expect(row.capability_checked_at).toBe(1234); expect(row.updated_at).toBe("now");
    }
    const backup = new Database(result.backup!, { readonly: true });
    try { expect(backup.prepare("SELECT id,api_key_ciphertext,capability_json,capability_checked_at,updated_at FROM model_configs ORDER BY id").all()).toEqual(before); }
    finally { backup.close(); }
    const migrated = ciphertexts();
    expect(await migrateLegacyKey(options)).toMatchObject({ state: "already-migrated" });
    expect(ciphertexts()).toEqual(migrated);
    initializeEncryptionKey(options);
    expect(encryptionStatus(options)).toMatchObject({ decryptable: true, source: "managed-file", pending: false });
  });
  it("rolls back a partial transaction and resumes using the durable prepared key", async () => {
    addModel(); addModel("m2"); const before = ciphertexts();
    database.exec("CREATE TRIGGER fail_migration BEFORE UPDATE OF api_key_ciphertext ON model_configs WHEN OLD.id='m2' BEGIN SELECT RAISE(ABORT,'simulated failure'); END");
    await expect(migrateLegacyKey(options)).rejects.toThrow("simulated failure");
    expect(ciphertexts()).toEqual(before);
    const pending = readManagedKey(managedKeyPath(options.databasePath))!;
    expect(pending.legacyMigrationPending).toBe(true);
    expect(() => initializeEncryptionKey(options)).toThrow("尚未完成");
    database.exec("DROP TRIGGER fail_migration");
    await migrateLegacyKey(options);
    expect(readManagedKey(managedKeyPath(options.databasePath))!.key).toBe(pending.key);
    expect(decryptSecret(ciphertexts()[0].api_key_ciphertext, pending.key)).toBe(originalSecret);
  });
  it("recovers a committed migration whose completion marker was not written", async () => {
    const pending = newManagedKey(true); writeManagedKey(managedKeyPath(options.databasePath), pending);
    addModel("m1", pending.key);
    initializeEncryptionKey(options);
    expect(readManagedKey(managedKeyPath(options.databasePath))!.legacyMigrationPending).toBe(false);
    expect(runtimeEncryptionKey(managedKeyPath(options.databasePath))).toBe(pending.key);
  });
  it("does not alter damaged/mixed credentials or create a new key", async () => {
    addModel(); addModel("m2", "another-independent-key-with-over-32-chars");
    const before = ciphertexts();
    await expect(migrateLegacyKey(options)).rejects.toThrow("全部模型");
    expect(ciphertexts()).toEqual(before);
    expect(fs.existsSync(managedKeyPath(options.databasePath))).toBe(false);
  });
  it("requires a stopped server and refuses unfinished tasks", async () => {
    addModel();
    const lock = await acquireInstanceLock(options.databasePath);
    try { await expect(migrateLegacyKey(options)).rejects.toThrow("已有服务"); }
    finally { await lock.release(); }
    database.exec("INSERT INTO import_jobs(id,filename,source_path,status,created_at,updated_at) VALUES('i','i','i','queued','now','now')");
    await expect(migrateLegacyKey(options)).rejects.toThrow("未恢复");
    expect(fs.existsSync(managedKeyPath(options.databasePath))).toBe(false);
  });
  it("preserves a valid external key, rejects a mismatched one, and skips local key generation", async () => {
    const externalKey = "external-key-preserved-with-32-plus-characters"; addModel("m1", externalKey);
    initializeEncryptionKey({ ...options, externalKey });
    expect(encryptionStatus({ ...options, externalKey })).toMatchObject({ source: "environment", decryptable: true });
    expect(() => initializeEncryptionKey({ ...options, externalKey: "wrong-key-with-more-than-thirty-two-characters" })).toThrow("无法解密");
    await expect(migrateLegacyKey({ ...options, externalKey })).rejects.toThrow("无需");
    expect(fs.existsSync(managedKeyPath(options.databasePath))).toBe(false);
    expect(() => externalEncryptionKey("short")).toThrow();
    expect(() => externalEncryptionKey(legacyEncryptionKey)).toThrow();
  });
  it("does not overwrite malformed, missing or mismatched managed keys after migration", async () => {
    addModel(); await migrateLegacyKey(options);
    const file = managedKeyPath(options.databasePath);
    const saved = fs.readFileSync(file);
    fs.writeFileSync(file, "malformed"); expect(() => initializeEncryptionKey(options)).toThrow("无法解析");
    fs.writeFileSync(file, saved);
    const different = newManagedKey(); writeManagedKey(file, different, true);
    await expect(migrateLegacyKey(options)).rejects.toThrow("拒绝覆盖");
    expect(readManagedKey(file)!.key).toBe(different.key);
    fs.unlinkSync(file);
    await expect(migrateLegacyKey(options)).rejects.toThrow("全部模型");
    expect(fs.existsSync(file)).toBe(false);
  });
  it("rejects linked secret directories and hardlinked key files", () => {
    fs.mkdirSync(path.join(root, "outside"));
    fs.symlinkSync(path.join(root, "outside"), path.join(root, ".secrets"), "junction");
    expect(() => initializeEncryptionKey(options)).toThrow("联接");
    fs.unlinkSync(path.join(root, ".secrets"));
    initializeEncryptionKey(options);
    fs.linkSync(managedKeyPath(options.databasePath), path.join(root, "linked-key"));
    expect(() => readManagedKey(managedKeyPath(options.databasePath))).toThrow("类型");
    fs.unlinkSync(path.join(root, "linked-key"));
  });
  it("restores migrated credentials in a new directory only with the matching separate key", async () => {
    addModel(); await migrateLegacyKey(options);
    const key = readManagedKey(managedKeyPath(options.databasePath))!;
    const restored = { databasePath: path.join(root, "restored/renamed.db") };
    fs.mkdirSync(path.dirname(restored.databasePath));
    await database.backup(restored.databasePath);
    expect(() => initializeEncryptionKey(restored)).toThrow("恢复原密钥");
    expect(fs.existsSync(managedKeyPath(restored.databasePath))).toBe(false);
    writeManagedKey(managedKeyPath(restored.databasePath), key);
    initializeEncryptionKey(restored);
    const copy = new Database(restored.databasePath, { readonly: true });
    try { expect(decryptSecret(copy.prepare("SELECT api_key_ciphertext FROM model_configs").get().api_key_ciphertext, key.key)).toBe(originalSecret); }
    finally { copy.close(); }
  });
  it("leaves all credentials and keys untouched if a protection backup cannot be created", async () => {
    addModel(); const before = ciphertexts();
    fs.writeFileSync(path.join(root, "backups"), "blocked directory");
    await expect(migrateLegacyKey(options)).rejects.toThrow();
    expect(ciphertexts()).toEqual(before);
    expect(fs.existsSync(managedKeyPath(options.databasePath))).toBe(false);
  });
});
