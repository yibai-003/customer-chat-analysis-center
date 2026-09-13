import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Only local configuration, never overrides explicit process variables. */
export function loadEnvironment(file = path.join(projectRoot, ".env"), target = process.env) {
  if (!fs.existsSync(file)) return;
  const parsed = parseEnv(fs.readFileSync(file, "utf8"));
  const allowed = new Set(["PORT", "DATA_DIR", "DATABASE_PATH", "ENCRYPTION_KEY", "MAX_UPLOAD_MB", "ANALYSIS_CONCURRENCY", "ANALYSIS_BATCH_SIZE", "MIN_FREE_DISK_MB", "BACKUP_INTERVAL_HOURS", "BACKUP_RETENTION", "CLEANUP_RETENTION_DAYS"]);
  for (const [key, value] of Object.entries(parsed)) if (allowed.has(key) && target[key] === undefined) target[key] = value;
}
if (process.env.NODE_ENV !== "test") loadEnvironment();
