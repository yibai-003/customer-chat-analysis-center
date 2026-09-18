// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { capabilitiesForRole } from "../../shared/types";

const currentUser = {
  id: "admin-1",
  organizationId: "org-default",
  username: "admin",
  displayName: "测试管理员",
  role: "admin",
  isEnabled: true,
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
};
const adminCapabilities = capabilitiesForRole("admin");

const jobs: unknown[] = [];

function jsonResponse(data: unknown) {
  return {
    ok: true,
    json: async () => ({ success: true, data }),
  } as Response;
}

function failedResponse(status: number, error: string) {
  return {
    ok: false,
    status,
    json: async () => ({ success: false, data: null, error }),
  } as Response;
}

let host: HTMLDivElement;
let root: Root;
let rootMounted = false;
let responseFor: (url: string, init?: RequestInit) => Response | Promise<Response>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function waitFor(assertion: () => void, timeout = 2000) {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeout) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
  }
  throw lastError;
}

function authenticationDefaults(url: string): Response {
  if (url === "/api/auth/me") return jsonResponse({ user: currentUser, capabilities: adminCapabilities });
  if (url === "/api/auth/status") return jsonResponse({ hasAdmin: true });
  if (url === "/api/jobs") return jsonResponse(jobs);
  if (url === "/api/sections") return jsonResponse([]);
  if (url === "/api/model-configs") return jsonResponse([]);
  throw new Error(`未处理的请求：${url}`);
}

function stubAuthFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  responseFor = handler;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => responseFor(String(input), init)));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  rootMounted = true;
  stubAuthFetch((url) => authenticationDefaults(url));
});

afterEach(async () => {
  if (rootMounted) {
    await act(async () => root.unmount());
  }
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("authentication gate", () => {
  it("shows a loading state while the session is being restored", async () => {
    const pending = deferred<Response>();
    stubAuthFetch((url) => url === "/api/auth/me" ? pending.promise : authenticationDefaults(url));

    await act(async () => root.render(<App />));

    expect(host.textContent).toContain("正在恢复会话");
    await act(async () => {
      pending.resolve(jsonResponse({ user: currentUser, capabilities: adminCapabilities }));
      await pending.promise;
    });
    await waitFor(() => expect(host.textContent).toContain("解析任务"));
  });

  it("renders the workspace with the signed-in user without fetching ordinary data first", async () => {
    const requests: string[] = [];
    stubAuthFetch((url, _init) => {
      requests.push("GET " + url);
      return authenticationDefaults(url);
    });

    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.querySelector(".user-chip")).not.toBeNull());
    expect(host.textContent).toContain("测试管理员");
    expect(host.textContent).toContain("管理员");
    expect(requests).toContain("GET /api/auth/me");
    expect(requests).toContain("GET /api/jobs");
  });

  it("shows the sign-in form with a bootstrap hint when no account exists", async () => {
    stubAuthFetch((url) => {
      if (url === "/api/auth/me") return jsonResponse({ user: null, capabilities: [] });
      if (url === "/api/auth/status") return jsonResponse({ hasAdmin: false });
      return authenticationDefaults(url);
    });

    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.querySelector("input[aria-label='账号']")).not.toBeNull());
    expect(host.textContent).toContain("bootstrap:admin");
    expect(host.textContent).not.toContain("解析任务");
  });

  it("shows a login error and keeps the form usable on failure", async () => {
    stubAuthFetch((url, _init) => {
      if (url === "/api/auth/me") return jsonResponse({ user: null, capabilities: [] });
      if (url === "/api/auth/status") return jsonResponse({ hasAdmin: true });
      if (url === "/api/auth/login") return failedResponse(401, "用户名或密码错误");
      return authenticationDefaults(url);
    });

    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.querySelector<HTMLButtonElement>(".signin-form button")).not.toBeNull());
    const username = host.querySelector<HTMLInputElement>("input[aria-label='账号']")!;
    const password = host.querySelector<HTMLInputElement>("input[aria-label='密码']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(username, "admin");
      username.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(password, "wrong");
      password.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>(".signin-form button")!.click());

    await waitFor(() => expect(host.textContent).toContain("用户名或密码错误"));
    const button = host.querySelector<HTMLButtonElement>(".signin-form button");
    expect(button?.disabled).toBe(false);
    expect(host.querySelector("input[aria-label='密码']")?.getAttribute("value")).toBe("wrong");
  });

  it("enters the workspace after a successful login", async () => {
    stubAuthFetch((url, init) => {
      if (url === "/api/auth/me") return jsonResponse({ user: null, capabilities: [] });
      if (url === "/api/auth/status") return jsonResponse({ hasAdmin: true });
      if (url === "/api/auth/login" && init?.method === "POST") return jsonResponse({ user: currentUser, capabilities: adminCapabilities });
      return authenticationDefaults(url);
    });

    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.querySelector("input[aria-label='账号']")).not.toBeNull());
    const username = host.querySelector<HTMLInputElement>("input[aria-label='账号']")!;
    const password = host.querySelector<HTMLInputElement>("input[aria-label='密码']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(username, "admin");
      username.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(password, "test-password-123");
      password.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>(".signin-form button")!.click());

    await waitFor(() => expect(host.querySelector(".user-chip")).not.toBeNull());
    expect(host.textContent).toContain("测试管理员");
    expect(host.textContent).toContain("解析任务");
  });

  it("returns to the sign-in screen and clears stale state when the session is lost", async () => {
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.querySelector(".user-chip")).not.toBeNull());

    stubAuthFetch((url) => {
      if (url === "/api/auth/me") return jsonResponse({ user: null, capabilities: [] });
      if (url === "/api/auth/status") return jsonResponse({ hasAdmin: true });
      return failedResponse(401, "未登录或会话已失效");
    });

    await act(async () => host.querySelector<HTMLButtonElement>(".user-signout")!.click());
    await waitFor(() => expect(host.querySelector("input[aria-label='账号']")).not.toBeNull());
    expect(host.textContent).not.toContain("测试管理员");
    expect(host.textContent).not.toContain("解析任务");
  });
});