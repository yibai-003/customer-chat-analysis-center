import { createApp } from "./app";
import { config } from "./config";
import { recoverStaleJobRuns } from "./db/repositories";
import { recoverImportJobs } from "./services/import-worker";
import fs from "node:fs";
import path from "node:path";
import { db } from "./db/client";
import { KnowledgeSync } from "./services/knowledge/knowledge-sync-service";

interface StartupServer {
  requestTimeout: number;
  headersTimeout: number;
  timeout: number;
}

interface StartupApplication {
  listen(port: number, callback: () => void): StartupServer;
}

export interface StartupDependencies {
  port: number;
  createApplication: () => StartupApplication;
  recoverStaleJobRuns: () => void;
  recoverImportJobs: () => void;
  log: (message: string) => void;
}

const defaultDependencies: StartupDependencies = {
  port: config.port,
  createApplication: createApp,
  recoverStaleJobRuns,
  recoverImportJobs,
  log: console.log,
};

export function startServer(
  dependencies: StartupDependencies = defaultDependencies,
): StartupServer {
  const server = dependencies.createApplication().listen(dependencies.port, () => {
    dependencies.recoverStaleJobRuns();
    dependencies.recoverImportJobs();
    dependencies.log(`客服解析中心 running at http://localhost:${dependencies.port}`);
    if (process.env.NODE_ENV !== "test") scheduleMaintenance(dependencies.log);
  });
  server.requestTimeout = 2 * 60 * 60 * 1000;
  server.headersTimeout = server.requestTimeout + 60_000;
  server.timeout = 0;
  return server;
}

function scheduleMaintenance(log: (message: string) => void) {
  const intervalMs = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS ?? 24)) * 60 * 60 * 1000;
  const run = () => {
    try {
      const backupDir = path.join(config.dataDir, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const target = path.join(backupDir, `scheduled-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
      db.prepare("VACUUM INTO ?").run(target);
      new KnowledgeSync().export();
      log(`scheduled backup created: ${target}`);
    } catch (error) { log(`scheduled backup failed: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
}
