import {
  bootstrapFirstAdmin,
  hasAnyUser,
  validatePassword,
  validateUsername,
} from "./identity-service";

const FIRST_ADMIN_VARS = ["FIRST_ADMIN_USERNAME", "FIRST_ADMIN_PASSWORD", "FIRST_ADMIN_DISPLAY_NAME"] as const;

/** Documented first-run environment path for the initial administrator (host-local only). */
export function hasFirstAdminEnvironment(): boolean {
  return FIRST_ADMIN_VARS.some((name) => (process.env[name] ?? "").length > 0);
}

/**
 * Creates the first administrator from the one-time environment path (process
 * environment or the host-local `.env`). Always no-ops once any account exists;
 * a partial configuration aborts loudly instead of leaving a half-configured
 * system. `FIRST_ADMIN_USERNAME` and `FIRST_ADMIN_PASSWORD` are both required;
 * the display name is optional and defaults to 管理员.
 */
export function ensureInitialAdminBootstrap(): boolean {
  if (hasAnyUser()) return false;
  if (!hasFirstAdminEnvironment()) return false;
  const username = (process.env.FIRST_ADMIN_USERNAME ?? "").trim();
  const password = process.env.FIRST_ADMIN_PASSWORD ?? "";
  const missing = [
    !username ? "FIRST_ADMIN_USERNAME" : "",
    !password ? "FIRST_ADMIN_PASSWORD" : "",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`首次管理员环境变量不完整：缺少 ${missing.join("、")}；请同时提供两项，或停止服务后运行 npm run bootstrap:admin`);
  }
  const displayName = (process.env.FIRST_ADMIN_DISPLAY_NAME ?? "").trim();
  bootstrapFirstAdmin({
    username: validateUsername(username),
    password: validatePassword(password, "FIRST_ADMIN_PASSWORD"),
    displayName: displayName || undefined,
  });
  return true;
}