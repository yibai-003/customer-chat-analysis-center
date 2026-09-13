import path from "node:path";
import { projectRoot } from "./environment";
import fs from "node:fs";
import { externalEncryptionKey, legacyEncryptionKey, managedKeyPath, runtimeEncryptionKey } from "./security/key-store";

export const config = {
  port: Number(process.env.PORT ?? 8787),
  dataDir: path.resolve(projectRoot, process.env.DATA_DIR ?? "./data"),
  databasePath: path.resolve(projectRoot, process.env.DATABASE_PATH ?? "./data/app.db"),
  get encryptionKey(): string {
    const file = managedKeyPath(config.databasePath);
    if (process.env.NODE_ENV === "test" && !fs.existsSync(file) && !process.env.ENCRYPTION_KEY) return legacyEncryptionKey;
    return runtimeEncryptionKey(file, process.env.ENCRYPTION_KEY);
  },
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 2048),
  analysisConcurrency: Number(process.env.ANALYSIS_CONCURRENCY ?? 2),
  analysisBatchSize: Number(process.env.ANALYSIS_BATCH_SIZE ?? 20),
  minFreeDiskMb: Number(process.env.MIN_FREE_DISK_MB ?? 512),
};

export function validateRuntimeConfig() {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("PORT 必须是 1-65535 之间的整数");
  }
  if (!Number.isFinite(config.maxUploadMb) || config.maxUploadMb <= 0) {
    throw new Error("MAX_UPLOAD_MB 必须是正数");
  }
  if (!Number.isInteger(config.analysisConcurrency) || config.analysisConcurrency < 1 || config.analysisConcurrency > 6) {
    throw new Error("ANALYSIS_CONCURRENCY 必须是 1-6 之间的整数");
  }
  if (!Number.isInteger(config.analysisBatchSize) || config.analysisBatchSize < 5 || config.analysisBatchSize > 100) {
    throw new Error("ANALYSIS_BATCH_SIZE 必须是 5-100 之间的整数");
  }
  if (!Number.isFinite(config.minFreeDiskMb) || config.minFreeDiskMb < 64) {
    throw new Error("MIN_FREE_DISK_MB 必须是不小于 64 的数值");
  }
  externalEncryptionKey(process.env.ENCRYPTION_KEY);
}
