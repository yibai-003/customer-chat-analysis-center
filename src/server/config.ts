import path from "node:path";
import { projectRoot } from "./environment";
import fs from "node:fs";
import { externalEncryptionKey, legacyEncryptionKey, managedKeyPath, runtimeEncryptionKey } from "./security/key-store";

function parseList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  listenHost: process.env.LISTEN_HOST ?? "127.0.0.1",
  allowedHosts: parseList(process.env.ALLOWED_HOSTS),
  allowedOrigins: parseList(process.env.ALLOWED_ORIGINS).map((value) => value.replace(/\/+$/, "")),
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
  sessionTtlMs: (Number(process.env.SESSION_TTL_HOURS ?? 168)) * 3600 * 1000,
  sessionCookieSecure: process.env.SESSION_COOKIE_SECURE !== "false",
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
  const sessionHours = Number(process.env.SESSION_TTL_HOURS ?? 168);
  if (!Number.isInteger(sessionHours) || sessionHours < 1 || sessionHours > 8760) {
    throw new Error("SESSION_TTL_HOURS 必须是 1-8760 之间的整数");
  }
  if (typeof config.listenHost !== "string" || !/^[A-Za-z0-9.\-:[\]]+$/.test(config.listenHost)) {
    throw new Error("LISTEN_HOST 必须是有效的主机名或 IP 地址");
  }
  for (const host of config.allowedHosts) {
    const hostname = host.replace(/:\d+$/, "");
    if (!/^[A-Za-z0-9.-]+$/.test(hostname)) throw new Error(`ALLOWED_HOSTS 中的主机名无效：${host}`);
  }
  for (const origin of config.allowedOrigins) {
    let parsed: URL | undefined;
    try { parsed = new URL(origin); } catch { parsed = undefined; }
    if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error(`ALLOWED_ORIGINS 必须是完整的 http/https 源（例如 https://chat.example.lan）：${origin}`);
    }
  }
  externalEncryptionKey(process.env.ENCRYPTION_KEY);
}
