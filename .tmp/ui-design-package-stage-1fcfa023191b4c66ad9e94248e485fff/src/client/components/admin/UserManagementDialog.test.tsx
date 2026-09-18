// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserManagementDialog } from "./UserManagementDialog";
import { capabilitiesForRole, type UserProfile } from "../../../shared/types";

const admin: UserProfile = {
  id: "u-admin",
  organizationId: "org-default",
  username: "admin",
  displayName: "总管理员",
  role: "admin",
  isEnabled: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-17T02:00:00.000Z",
};
const operator: UserProfile = {
  id: "u-operator",
  organizationId: "org-default",
  username: "zhang",
  displayName: "张三",
  role: "operator",
  isEnabled: true,
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-16T09:30:00.000Z",
};

let host: HTMLDivElement;
let root: Root;
let rootMounted = false;
let users: UserProfile[];
let requests: Array<{ url: string; init?: RequestInit }>;
let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;

function jsonResponse(data: unknown) {
  return { ok: true, json: async () => ({ success: true, data }) } as Response;
}

function failureResponse(status: number, error: string) {
  return { ok: false, status, json: async () => ({ success: false, data: null, error }) } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function waitFor(assertion: () => void, timeout = 2000) {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeout) {
    try { assertion(); return; } catch (error) {
      lastError = error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
  }
  throw lastError;
}

function buttonByText(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);
}

function labeled<T extends HTMLElement>(label: string) {
  return host.querySelector<T>(`[aria-label="${label}"]`);
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

function userRow(username: string) {
  return [...host.querySelectorAll<HTMLDivElement>(".admin-user-row")]
    .find((row) => row.querySelector("strong")?.textContent === username);
}

function postRequests() {
  return requests.filter((request) => request.url === "/api/admin/users" && request.init?.method === "POST");
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  rootMounted = true;
  users = [admin, operator];
  requests = [];
  handler = (url, init) => {
    if (url === "/api/admin/users" && (init?.method ?? "GET") === "GET") return jsonResponse(users);
    throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    return handler(url, init);
  }));
});

afterEach(async () => {
  if (rootMounted) await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderDialog() {
  await act(async () => root.render(<UserManagementDialog close={vi.fn()} />));
  await waitFor(() => expect(host.querySelector(".admin-user-row")).not.toBeNull());
}

describe("admin user management dialog", () => {
  it("lists accounts with role, state and update time without exposing credentials", async () => {
    await renderDialog();

    expect(host.textContent).toContain("admin");
    expect(host.textContent).toContain("总管理员");
    expect(host.textContent).toContain("管理员");
    expect(host.textContent).toContain("操作人员");
    expect(host.textContent).toContain("已启用");
    expect(host.textContent).toContain("更新于 2026-09-17 02:00");
    const serialized = host.innerHTML.toLowerCase();
    expect(serialized).not.toContain("password_hash");
    expect(serialized).not.toContain("cc_sid");
    expect(serialized).not.toContain("apikey");
    expect(capabilitiesForRole("admin")).toContain("user:manage");
  });

  it("validates the create form before calling the server", async () => {
    await renderDialog();

    await act(async () => buttonByText("创建账号")!.click());
    expect(host.textContent).toContain("用户名长度必须为 1-100 个字符");

    await act(async () => setValue(labeled<HTMLInputElement>("账号")!, "bad name!"));
    await act(async () => setValue(labeled<HTMLInputElement>("显示名称")!, "李四"));
    await act(async () => setValue(labeled<HTMLInputElement>("初始密码")!, "long-enough-password"));
    await act(async () => buttonByText("创建账号")!.click());
    expect(host.textContent).toContain("用户名只能包含字母、数字、下划线、点、短横线、@");

    await act(async () => setValue(labeled<HTMLInputElement>("账号")!, "lisi"));
    await act(async () => setValue(labeled<HTMLInputElement>("初始密码")!, "short"));
    await act(async () => buttonByText("创建账号")!.click());
    expect(host.textContent).toContain("密码长度必须为 8-512 个字符");
    expect(postRequests()).toHaveLength(0);
  });

  it("creates an account with the chosen role, clears the form and refreshes the list", async () => {
    await renderDialog();
    handler = (url, init) => {
      if (url === "/api/admin/users" && (init?.method ?? "GET") === "GET") return jsonResponse(users);
      if (url === "/api/admin/users" && init?.method === "POST") {
        const created = { ...operator, id: "u-new", username: "lisi", displayName: "李四", role: "reviewer" as const };
        users = [...users, created];
        return jsonResponse(created);
      }
      throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
    };

    await act(async () => setValue(labeled<HTMLInputElement>("账号")!, "lisi"));
    await act(async () => setValue(labeled<HTMLInputElement>("显示名称")!, "李四"));
    await act(async () => setValue(labeled<HTMLInputElement>("初始密码")!, "reviewer-password-1"));
    await act(async () => setValue(labeled<HTMLSelectElement>("角色")!, "reviewer"));
    await act(async () => buttonByText("创建账号")!.click());

    await waitFor(() => expect(host.textContent).toContain("账号已创建"));
    const body = JSON.parse(String(postRequests()[0]!.init!.body));
    expect(body).toEqual({ username: "lisi", displayName: "李四", password: "reviewer-password-1", role: "reviewer" });
    expect(labeled<HTMLInputElement>("账号")!.value).toBe("");
    expect(labeled<HTMLInputElement>("初始密码")!.value).toBe("");
    expect(userRow("lisi")).not.toBeNull();
    expect(userRow("lisi")!.textContent).toContain("审核人员");
  });

  it("keeps the create form and shows the reason when the server rejects it", async () => {
    await renderDialog();
    handler = (url, init) => {
      if (url === "/api/admin/users" && (init?.method ?? "GET") === "GET") return jsonResponse(users);
      if (url === "/api/admin/users" && init?.method === "POST") return failureResponse(400, "用户名已存在");
      throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
    };

    await act(async () => setValue(labeled<HTMLInputElement>("账号")!, "zhang"));
    await act(async () => setValue(labeled<HTMLInputElement>("显示名称")!, "重复账号"));
    await act(async () => setValue(labeled<HTMLInputElement>("初始密码")!, "some-password-1"));
    await act(async () => buttonByText("创建账号")!.click());

    await waitFor(() => expect(host.textContent).toContain("用户名已存在"));
    expect(labeled<HTMLInputElement>("账号")!.value).toBe("zhang");
    expect(labeled<HTMLInputElement>("显示名称")!.value).toBe("重复账号");
    expect(buttonByText("创建账号")!.disabled).toBe(false);
  });

  it("submits create only once while the request is in flight", async () => {
    await renderDialog();
    const pending = deferred<Response>();
    handler = (url, init) => {
      if (url === "/api/admin/users" && (init?.method ?? "GET") === "GET") return jsonResponse(users);
      if (url === "/api/admin/users" && init?.method === "POST") return pending.promise;
      throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
    };

    await act(async () => setValue(labeled<HTMLInputElement>("账号")!, "lisi"));
    await act(async () => setValue(labeled<HTMLInputElement>("显示名称")!, "李四"));
    await act(async () => setValue(labeled<HTMLInputElement>("初始密码")!, "reviewer-password-1"));
    await act(async () => buttonByText("创建账号")!.click());
    expect(buttonByText("创建中…")!.disabled).toBe(true);
    await act(async () => buttonByText("创建中…")!.click());

    expect(postRequests()).toHaveLength(1);
    await act(async () => {
      pending.resolve(failureResponse(400, "用户名已存在"));
      await pending.promise;
    });
    await waitFor(() => expect(buttonByText("创建账号")!.disabled).toBe(false));
  });

  it("updates display name and role from the server after saving", async () => {
    await renderDialog();
    handler = (url, init) => {
      if (url === "/api/admin/users" && (init?.method ?? "GET") === "GET") return jsonResponse(users);
      if (url === "/api/admin/users/u-operator" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        users = users.map((user) => user.id === "u-operator" ? { ...user, ...body } : user);
        return jsonResponse(users.find((user) => user.id === "u-operator")!);
      }
      throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
    };

    await act(async () => userRow("zhang")!.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => setValue(labeled<HTMLInputElement>("显示名称 zhang")!, "张三丰"));
    await act(async () => setValue(labeled<HTMLSelectElement>("角色 zhang")!, "reviewer"));
    await act(async () => buttonByText("保存")!.click());

    await waitFor(() => expect(host.textContent).toContain("账号已更新"));
    const patch = requests.find((request) => request.url === "/api/admin/users/u-operator")!;
    expect(JSON.parse(String(patch.init!.body))).toEqual({ displayName: "张三丰", role: "reviewer" });
    expect(userRow("zhang")!.textContent).toContain("张三丰");
    expect(userRow("zhang")!.textContent).toContain("审核人员");
  });

  it("shows the server reason and keeps the server state when the last admin change is rejected", async () => {
    await renderDialog();
    handler = (url, init) => {
      if (url === "/api/admin/users" && (init?.method ?? "GET") === "GET") return jsonResponse(users);
      if (url === "/api/admin/users/u-admin" && init?.method === "PATCH") {
        return failureResponse(400, "必须保留至少一个启用中的管理员");
      }
      throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
    };

    await act(async () => userRow("admin")!.querySelectorAll<HTMLButtonElement>("button")[0]!.click());
    await act(async () => setValue(labeled<HTMLSelectElement>("角色 admin")!, "config"));
    await act(async () => buttonByText("保存")!.click());

    await waitFor(() => expect(host.textContent).toContain("必须保留至少一个启用中的管理员"));
    expect(userRow("admin")!.textContent).toContain("已启用");
    expect(host.textContent).not.toContain("账号已更新");
    await waitFor(() => expect(requests.filter((request) => request.url === "/api/admin/users" && (request.init?.method ?? "GET") === "GET").length).toBeGreaterThanOrEqual(2));
  });

  it("disables an account after confirmation and reflects the server state", async () => {
    await renderDialog();
    handler = (url, init) => {
      if (url === "/api/admin/users" && (init?.method ?? "GET") === "GET") return jsonResponse(users);
      if (url === "/api/admin/users/u-operator" && init?.method === "PATCH") {
        users = users.map((user) => user.id === "u-operator" ? { ...user, isEnabled: false } : user);
        return jsonResponse(users.find((user) => user.id === "u-operator")!);
      }
      throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
    };

    await act(async () => [...userRow("zhang")!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "停用")!.click());
    expect(host.textContent).toContain("该账号的既有会话会立即失效");
    await act(async () => host.querySelector<HTMLButtonElement>(".danger-button")!.click());

    await waitFor(() => expect(host.textContent).toContain("账号已停用，既有会话已撤销"));
    const patch = requests.find((request) => request.url === "/api/admin/users/u-operator")!;
    expect(JSON.parse(String(patch.init!.body))).toEqual({ isEnabled: false });
    expect(userRow("zhang")!.textContent).toContain("已停用");
  });

  it("rejects disabling the last administrator and keeps the enabled state", async () => {
    await renderDialog();
    handler = (url, init) => {
      if (url === "/api/admin/users" && (init?.method ?? "GET") === "GET") return jsonResponse(users);
      if (url === "/api/admin/users/u-admin" && init?.method === "PATCH") {
        return failureResponse(400, "必须保留至少一个启用中的管理员");
      }
      throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
    };

    await act(async () => [...userRow("admin")!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "停用")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".danger-button")!.click());

    await waitFor(() => expect(host.textContent).toContain("必须保留至少一个启用中的管理员"));
    expect(userRow("admin")!.textContent).toContain("已启用");
    expect(host.textContent).not.toContain("账号已停用，既有会话已撤销");
  });

  it("resets a password with double confirmation and never stores it", async () => {
    await renderDialog();
    handler = (url, init) => {
      if (url === "/api/admin/users" && (init?.method ?? "GET") === "GET") return jsonResponse(users);
      if (url === "/api/admin/users/u-operator/reset-password" && init?.method === "POST") {
        return jsonResponse(operator);
      }
      throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
    };

    await act(async () => [...userRow("zhang")!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "重置密码")!.click());
    await act(async () => setValue(labeled<HTMLInputElement>("新密码")!, "new-password-123"));
    await act(async () => setValue(labeled<HTMLInputElement>("确认新密码")!, "different-password"));
    await act(async () => buttonByText("确认重置")!.click());
    expect(host.textContent).toContain("两次输入的密码不一致");
    expect(requests.some((request) => request.url.includes("reset-password"))).toBe(false);

    await act(async () => setValue(labeled<HTMLInputElement>("确认新密码")!, "new-password-123"));
    await act(async () => buttonByText("确认重置")!.click());
    expect(host.textContent).toContain("该账号的既有会话会立即失效");
    await act(async () => host.querySelector<HTMLButtonElement>(".danger-button")!.click());

    await waitFor(() => expect(host.textContent).toContain("密码已重置，该账号既有会话已撤销"));
    const resetRequest = requests.find((request) => request.url === "/api/admin/users/u-operator/reset-password")!;
    expect(JSON.parse(String(resetRequest.init!.body))).toEqual({ password: "new-password-123" });
    expect(requests.some((request) => request.url.includes("new-password-123"))).toBe(false);
    expect(host.innerHTML).not.toContain("new-password-123");
    expect(localStorage.length).toBe(0);
    expect(host.textContent).not.toContain("重置“zhang”的密码");
  });

  it("keeps the reset form usable when the network fails", async () => {
    await renderDialog();
    handler = (url, init) => {
      if (url === "/api/admin/users" && (init?.method ?? "GET") === "GET") return jsonResponse(users);
      if (url === "/api/admin/users/u-operator/reset-password" && init?.method === "POST") {
        throw new Error("网络不可用");
      }
      throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
    };

    await act(async () => [...userRow("zhang")!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "重置密码")!.click());
    await act(async () => setValue(labeled<HTMLInputElement>("新密码")!, "new-password-123"));
    await act(async () => setValue(labeled<HTMLInputElement>("确认新密码")!, "new-password-123"));
    await act(async () => buttonByText("确认重置")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".danger-button")!.click());

    await waitFor(() => expect(host.textContent).toContain("网络不可用"));
    expect(labeled<HTMLInputElement>("新密码")!.value).toBe("new-password-123");
    expect(host.textContent).toContain("重置“zhang”的密码");
  });
});