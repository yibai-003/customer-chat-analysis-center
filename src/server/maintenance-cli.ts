import { config } from "./config";
import { projectRoot } from "./environment";
import { maintainFiles } from "./services/maintenance-service";

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !["--apply", "--dry-run"].includes(args[0]))) throw new Error("用法：npm run maintenance -- [--dry-run|--apply]");
  console.log(JSON.stringify(await maintainFiles({ databasePath: config.databasePath, dataDir: config.dataDir, projectRoot,
    days: process.env.CLEANUP_RETENTION_DAYS === undefined ? undefined : Number(process.env.CLEANUP_RETENTION_DAYS), apply: args[0] === "--apply" }), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "清理失败");
  process.exitCode = 1;
}
