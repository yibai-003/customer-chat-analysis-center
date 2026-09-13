import { config } from "./config";
import { encryptionStatus, migrateLegacyKey } from "./security/key-manager";

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !["--status", "--apply"].includes(args[0]))) throw new Error("用法：npm run keys:migrate -- [--status|--apply]");
  const options = { databasePath: config.databasePath, externalKey: process.env.ENCRYPTION_KEY };
  console.log(JSON.stringify(args[0] === "--apply" ? await migrateLegacyKey(options) : encryptionStatus(options), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "密钥迁移失败");
  process.exitCode = 1;
}
