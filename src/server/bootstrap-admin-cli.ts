import { config } from "./config";
import { acquireInstanceLock } from "./instance-lock";
import { bootstrapFirstAdmin, hasAnyUser, validatePassword } from "./auth/identity-service";

function parseArgs() {
  const args = process.argv.slice(2);
  const read = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : undefined;
  };
  const username = read("username") ?? read("user") ?? process.env.FIRST_ADMIN_USERNAME;
  const password = read("password") ?? read("pass") ?? process.env.FIRST_ADMIN_PASSWORD;
  const displayName = read("display-name") ?? process.env.FIRST_ADMIN_DISPLAY_NAME;
  return { username, password, displayName };
}

try {
  const { username, password, displayName } = parseArgs();
  if (!username || !password) {
    throw new Error("用法：npm run bootstrap:admin -- --username <账号> --password <初始密码> [--display-name <显示名称>]");
  }
  validatePassword(password, "初始密码");
  const lock = await acquireInstanceLock(config.databasePath);
  try {
    const { initDb } = await import("./db/client");
    initDb();
    if (hasAnyUser()) throw new Error("系统已存在账号，管理员引导已失效，不需要重复创建");
    const user = bootstrapFirstAdmin({ username, password, displayName: displayName || undefined });
    console.log(`首次管理员引导完成：账号 ${user.username}（${user.displayName}，角色 admin）`);
    console.log("请立即登录，之后不要在命令行或环境变量中保留该密码。");
  } finally {
    await lock.release();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "管理员引导失败");
  process.exitCode = 1;
}