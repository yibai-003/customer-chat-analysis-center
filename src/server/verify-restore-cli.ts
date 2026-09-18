import { verifyRestoredEnvironment } from "./services/restore-verification";

try {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error("用法：npm run restore:verify -- <恢复目录>");
  const result = verifyRestoredEnvironment(args[0], { externalKey: process.env.ENCRYPTION_KEY });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "恢复校验失败");
  process.exitCode = 1;
}