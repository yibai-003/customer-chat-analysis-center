import { pathToFileURL } from "node:url";

const failureJson = JSON.stringify({
  ready: false,
  database: false,
  error: "Readiness check failed",
});

export async function runReadinessCliEntry(): Promise<number> {
  try {
    const { runReadinessCli } = await import("./readiness-cli");
    return runReadinessCli();
  } catch {
    console.log(failureJson);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runReadinessCliEntry();
}
