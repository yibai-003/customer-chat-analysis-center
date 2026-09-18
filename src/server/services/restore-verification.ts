import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { appliedMigrations, currentSchemaVersion } from "../db/migrations";
import { encryptionStatus } from "../security/key-manager";
import { validateCatalog } from "./knowledge/knowledge-sync-service";

export interface RestoreCheck {
  name: string;
  ok: boolean;
  detail: unknown;
}

export interface RestoreVerification {
  directory: string;
  ok: boolean;
  checks: RestoreCheck[];
}

/**
 * Verifies a directory produced by `restoreFullBackup` before it may replace a
 * running environment: database integrity/version, referenced files, knowledge
 * snapshot and the matching model-credential key.
 */
export function verifyRestoredEnvironment(
  directory: string,
  options: { externalKey?: string } = {},
): RestoreVerification {
  const target = path.resolve(directory);
  const checks: RestoreCheck[] = [];
  const check = (name: string, run: () => unknown) => {
    try {
      checks.push({ name, ok: true, detail: run() ?? null });
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  check("restored-marker", () => {
    const marker = path.join(target, "RESTORED.json");
    if (!fs.existsSync(marker)) throw new Error("缺少 RESTORED.json，目录不是独立恢复副本");
    const parsed = JSON.parse(fs.readFileSync(marker, "utf8")) as { restoredAt?: string };
    return { restoredAt: parsed.restoredAt ?? null };
  });

  const databasePath = path.join(target, "data", "app.db");
  check("database", () => {
    if (!fs.existsSync(databasePath)) throw new Error("恢复数据库不存在");
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      if (database.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("数据库完整性检查失败");
      const foreignKeys = database.pragma("foreign_key_check");
      if (foreignKeys.length) throw new Error(`数据库外键检查失败：${foreignKeys.length} 项`);
      const version = appliedMigrations(database).at(-1)?.version ?? 0;
      if (version !== currentSchemaVersion) throw new Error(`数据库版本 ${version} 与程序支持版本 ${currentSchemaVersion} 不一致`);
      return { version };
    } finally {
      database.close();
    }
  });

  check("file-references", () => {
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const rows = [
        ...(database.prepare("SELECT id, source_path AS file FROM jobs WHERE source_path <> ''").all() as Array<{ id: string; file: string }>)
          .map((row) => ({ kind: "job", ...row })),
        ...(database.prepare("SELECT id, image_path AS file FROM records WHERE image_path <> ''").all() as Array<{ id: string; file: string }>)
          .map((row) => ({ kind: "record", ...row })),
      ];
      const missing = rows.filter((row) => !fs.existsSync(row.file));
      if (missing.length) throw new Error(`数据库引用的文件缺失 ${missing.length} 项：${missing.slice(0, 3).map((row) => `${row.kind}:${row.id}`).join("、")}`);
      return { checked: rows.length };
    } finally {
      database.close();
    }
  });

  check("knowledge-catalog", () => {
    const catalogPath = path.join(target, "knowledge", "catalog.json");
    if (!fs.existsSync(catalogPath)) throw new Error("知识快照不存在");
    const text = fs.readFileSync(catalogPath, "utf8");
    validateCatalog(JSON.parse(text));
    const statePath = path.join(target, "data", "knowledge-sync-state.json");
    if (!fs.existsSync(statePath)) return { hash: null };
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as { hash?: string };
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    if (state.hash !== hash) throw new Error("知识快照与同步状态哈希不一致");
    return { hash };
  });

  check("model-credentials", () => {
    if (!fs.existsSync(databasePath)) throw new Error("恢复数据库不存在");
    const status = encryptionStatus({ databasePath, externalKey: options.externalKey });
    if (status.models > 0 && !status.decryptable) {
      throw new Error(`模型凭据无法用当前密钥解密（密钥来源 ${status.source}）；请提供匹配的 .secrets 密钥文件或 ENCRYPTION_KEY`);
    }
    return { source: status.source, models: status.models, decryptable: status.decryptable, pending: status.pending };
  });

  return { directory: target, ok: checks.every((item) => item.ok), checks };
}