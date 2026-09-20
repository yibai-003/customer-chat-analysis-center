import { pathToFileURL } from "node:url";
import { getReadinessStatus, type ReadinessStatus } from "./services/readiness-service";

export interface ReadinessCliOptions {
  provider?: () => ReadinessStatus;
  write?: (value: string) => void;
}

export function runReadinessCli(options: ReadinessCliOptions = {}): number {
  const status = (options.provider ?? getReadinessStatus)();
  (options.write ?? console.log)(JSON.stringify(status));
  return status.ready ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runReadinessCli();
}
