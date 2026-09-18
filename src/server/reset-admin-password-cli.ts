import { config } from "./config";
import { acquireInstanceLock } from "./instance-lock";
import { initDb } from "./db/client";
import { listUsers, resetPassword, validatePassword } from "./auth/identity-service";

function parseArgs() {
  const args = process.argv.slice(2);
  const read = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : undefined;
  };
  return {
    username: read("username") ?? read("user") ?? "admin",
    password: read("password") ?? read("pass") ?? process.env.ADMIN_PASSWORD,
  };
}

try {
  const { username: rawUsername, password } = parseArgs();
  if (!rawUsername || !password) {
    throw new Error("用法：npm run reset:admin -- --username <账号> --password <新密码>");
  }
  const username = rawUsername.trim();
  if (!username) throw new Error("账号不能为空");
  validatePassword(password, "新密码");

  const lock = await acquireInstanceLock(config.databasePath);
  try {
    initDb();
    const user = listUsers().find((candidate) => candidate.username === username);
    if (!user) throw new Error(`账号不存在：${username}`);
    if (user.role !== "admin") throw new Error(`账号不是管理员：${username}`);
    resetPassword(user.id, password);
    console.log(`管理员密码已重置：账号 ${user.username}（${user.displayName}）`);
    console.log("请立即登录并在安全位置保存新密码；命令行和环境变量中不要继续保留该密码。");
  } finally {
    await lock.release();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "管理员密码重置失败");
  process.exitCode = 1;
}
