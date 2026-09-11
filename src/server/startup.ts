import { createApp } from "./app";
import { config } from "./config";
import { recoverStaleJobRuns } from "./db/repositories";
import { recoverImportJobs } from "./services/import-worker";

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
  });
  server.requestTimeout = 2 * 60 * 60 * 1000;
  server.headersTimeout = server.requestTimeout + 60_000;
  server.timeout = 0;
  return server;
}
