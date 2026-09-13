import { restoreFullBackup, verifyBackup } from "./services/backup-service";

try {
  const args = process.argv.slice(2);
  if (args[0] === "--verify" && args.length === 2) {
    const manifest = await verifyBackup(args[1]);
    console.log(JSON.stringify({ verified: true, createdAt: manifest.createdAt, files: manifest.files.length }));
  } else if (args.length === 3 && args[1] === "--to") {
    console.log(JSON.stringify(await restoreFullBackup(args[0], args[2]), null, 2));
    console.log("恢复到新目录完成，原环境未修改。使用原加密密钥；检查文件后按恢复指南切换。");
  } else throw new Error("Usage: npm run restore -- <backup-directory> --to <NEW-directory> | --verify <backup-directory>");
} catch (error) {
  console.error(error instanceof Error ? error.message : "恢复失败");
  process.exitCode = 1;
}
