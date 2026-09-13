import { createApp } from "./app";
import { config } from "./config";
import { recoverStaleJobRuns } from "./db/repositories";
import { recoverImportJobs } from "./services/import-worker";
import path from "node:path";
import { db } from "./db/client";
import { captureCatalog } from "./services/knowledge/knowledge-sync-service";
import { createFullBackup, positiveInteger } from "./services/backup-service";
import { scheduleBackups } from "./services/backup-scheduler";

interface StartupServer {
  once?: (event: "close", callback: () => void) => unknown;
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
  const retention = positiveInteger(process.env.BACKUP_RETENTION, "BACKUP_RETENTION", 7);
  const hours = positiveInteger(process.env.BACKUP_INTERVAL_HOURS, "BACKUP_INTERVAL_HOURS", 24, 8760);
  const server = dependencies.createApplication().listen(dependencies.port, () => {
    dependencies.recoverStaleJobRuns();
    dependencies.recoverImportJobs();
    dependencies.log(`客服解析中心 running at http://localhost:${dependencies.port}`);
    if (process.env.NODE_ENV !== "test") {
      const root = path.join(config.dataDir, "backups");
      const stop = scheduleBackups({ root, hours, log: dependencies.log,
        busy: () => Boolean(db.prepare("SELECT id FROM jobs WHERE run_token IS NOT NULL LIMIT 1").get()
          || db.prepare("SELECT id FROM records WHERE status='processing' LIMIT 1").get()
          || db.prepare("SELECT id FROM import_jobs WHERE status IN ('queued','processing') LIMIT 1").get()),
        create: () => createFullBackup({ database: db, backupRoot: root, retention, catalog: captureCatalog }),
      });
      server.once?.("close", stop);
    }
  });
  server.requestTimeout = 2 * 60 * 60 * 1000;
  server.headersTimeout = server.requestTimeout + 60_000;
  server.timeout = 0;
  return server;
}
