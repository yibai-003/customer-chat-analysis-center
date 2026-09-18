import { hasAnyUser, bootstrapFirstAdmin } from "./identity-service";

export const TEST_ADMIN = { username: "admin", password: "test-password-123", displayName: "测试管理员" };

/** Ensures the shared test database has an administrator (idempotent per worker). */
export function ensureTestAdmin() {
  if (!hasAnyUser()) bootstrapFirstAdmin(TEST_ADMIN);
}

export async function loginAdmin(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: TEST_ADMIN.username, password: TEST_ADMIN.password }),
  });
  if (!response.ok) {
    throw new Error(`测试管理员登录失败：${response.status} ${await response.text()}`);
  }
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("登录未返回会话 Cookie");
  return header.split(";")[0]!;
}

export function withAuth(cookie: string, init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: { ...init?.headers, cookie },
  };
}