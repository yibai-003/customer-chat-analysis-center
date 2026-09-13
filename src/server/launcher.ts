import path from "node:path";
import { config, validateRuntimeConfig } from "./config";
import { projectRoot } from "./environment";
import { positiveInteger } from "./services/backup-service";
import { runLoggedProcess } from "./services/logged-process";

try {
  validateRuntimeConfig();
  const maxMb = positiveInteger(process.env.LOG_MAX_MB, "LOG_MAX_MB", 10, 100);
  const retention = positiveInteger(process.env.LOG_RETENTION, "LOG_RETENTION", 7, 30);
  process.exitCode = await runLoggedProcess({ command: process.execPath,
    args: ["--import", "tsx", "src/server/index.ts"], cwd: projectRoot,
    logDir: path.join(config.dataDir, "logs"), maxBytes: maxMb * 1024 * 1024, retention, mirror: true });
} catch (error) {
  console.error(error instanceof Error ? error.message : "服务启动失败");
  process.exitCode = 1;
}
