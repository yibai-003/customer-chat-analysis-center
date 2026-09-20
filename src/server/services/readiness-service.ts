import fs from "node:fs";
import Database from "better-sqlite3";
import { config } from "../config";
import {
  appliedMigrations,
  currentSchemaVersion,
  migrations,
} from "../db/migrations";
import {
  getModelReadinessActions,
  getModelReadinessChecks,
} from "./model-config-service";

export interface ReadinessDependencies {
  dataDir: string;
  minFreeDiskMb: number;
  statfs: (path: string) => { bavail: number | bigint; bsize: number | bigint };
  databasePath?: string;
  databaseCheck?: (databasePath: string) => boolean;
  modelChecks: typeof getModelReadinessChecks;
  modelActions: typeof getModelReadinessActions;
}

export interface ReadinessStatus {
  ready: boolean;
  database: boolean;
  freeDiskMb: number;
  minFreeDiskMb: number;
  models: { vision: boolean; text: boolean };
  modelChecks: ReturnType<typeof getModelReadinessChecks>;
  actions: ReturnType<typeof getModelReadinessActions>;
}

const defaults: ReadinessDependencies = {
  dataDir: config.dataDir,
  minFreeDiskMb: config.minFreeDiskMb,
  statfs: fs.statfsSync,
  databasePath: config.databasePath,
  databaseCheck: isDatabaseReady,
  modelChecks: getModelReadinessChecks,
  modelActions: getModelReadinessActions,
};

const REQUIRED_TABLES = [
  "analysis_sections",
  "analysis_fields",
  "knowledge_bases",
  "knowledge_items",
];

export function isDatabaseReady(databasePath: string): boolean {
  if (!fs.existsSync(databasePath)) return false;
  let database: InstanceType<typeof Database> | undefined;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    if (database.pragma("integrity_check", { simple: true }) !== "ok") return false;
    if (database.pragma("foreign_key_check").length > 0) return false;
    const applied = appliedMigrations(database);
    const hasLegacyVersion = applied[0]?.version === 1;
    const current = hasLegacyVersion ? applied.slice(1) : applied;
    if (
      current.length !== migrations.length
      || current.at(-1)?.version !== currentSchemaVersion
      || current.some((migration, index) => {
        const expected = migrations[index];
        return migration.version !== expected.version || migration.name !== expected.name;
      })
    ) {
      return false;
    }
    return REQUIRED_TABLES.every((table) => (
      database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table)
    ));
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

export function getReadinessStatus(
  dependencies: ReadinessDependencies = defaults,
): ReadinessStatus {
  const resolved = { ...defaults, ...dependencies };
  const disk = resolved.statfs(resolved.dataDir);
  const freeDiskMb = Math.floor(
    Number(disk.bavail) * Number(disk.bsize) / 1024 / 1024,
  );
  const database = resolved.databaseCheck!(resolved.databasePath!);
  const modelChecks = resolved.modelChecks();
  const models = {
    vision: modelChecks.vision.verified,
    text: modelChecks.text.verified,
  };

  return {
    ready: database
      && freeDiskMb >= resolved.minFreeDiskMb
      && models.vision
      && models.text,
    database,
    freeDiskMb,
    minFreeDiskMb: resolved.minFreeDiskMb,
    models,
    modelChecks,
    actions: resolved.modelActions(),
  };
}
