import { notifyAccessDenied, notifyAuthLost } from "./auth/session";

export const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) notifyAuthLost();
  if (response.status === 403) notifyAccessDenied(body.error || "当前角色无权执行此操作");
  if (!response.ok || body.success === false) throw new Error(body.error || "请求失败");
  return body.data as T;
};