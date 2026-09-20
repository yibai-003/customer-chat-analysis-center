import { getReadinessStatus, type ReadinessStatus } from "./services/readiness-service";

export interface ReadinessCliOptions {
  provider?: () => ReadinessStatus;
  write?: (value: string) => void;
}

export interface ReadinessCliFailure {
  ready: false;
  database: false;
  error: string;
}

const failureJson = JSON.stringify({
  ready: false,
  database: false,
  error: "Readiness check failed",
} satisfies ReadinessCliFailure);

export function runReadinessCli(options: ReadinessCliOptions = {}): number {
  let output: string;
  let exitCode = 1;

  try {
    const status = (options.provider ?? getReadinessStatus)();
    output = JSON.stringify(status);
    exitCode = status.ready ? 0 : 1;
  } catch {
    output = failureJson;
  }

  (options.write ?? console.log)(output);
  return exitCode;
}
