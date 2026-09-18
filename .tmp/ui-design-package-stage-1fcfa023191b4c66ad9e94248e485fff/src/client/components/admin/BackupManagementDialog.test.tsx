// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupManagementDialog } from "./BackupManagementDialog";
import type { BackupCreation, BackupEntry, RestoreCopy, RestoreVerification } from "../../../shared/types";

const backup: BackupEntry = { name: "full-2026-09-17T10-00-00-000Z-abc", createdAt: "2026-09-17T10:00:00.000Z", valid: true };
const created: BackupCreation = { name: "full-new", files: 4, references: 3, verified: true, warnings: [] };
const restoreCopy: RestoreCopy = { directory: "D:\\recovery-20260917", database: "D:\\recovery-20260917\\data/app.db", files: 3, verified: true };
const verification: RestoreVerification = {
  directory: restoreCopy.directory,
  ok: true,
  checks: [
    { name: "restored-marker", ok: true, detail: null },
    { name: "database", ok: true, detail: { version: 17 } },
    { name: "file-references", ok: true, detail: { checked: 2 } },
    { name: "knowledge-catalog", ok: true, detail: null },
    { name: "model-credentials", ok: true, detail: { models: 1 } },
  ],
};

let host: HTMLDivElement;
let root: Root;
let rootMounted = false;
let requests: Array<{ url: string; init?: RequestInit }>;
let backups: BackupEntry[];
let handler: (url: string, init?: RequestInit) => Response;

function jsonResponse(data: unknown) {
  return { ok: true, json: async () => ({ success: true, data }) } as Response;
}

function failureResponse(status: number, error: string) {
  return { ok: false, status, json: async () => ({ success: false, data: null, error }) } as Response;
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

function labeled<T extends HTMLElement>(label: string) {
  return host.querySelector<T>(`[aria-label="${label}"]`);
}

function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  rootMounted = true;
  requests = [];
  backups = [backup];
  handler = (url, init) => {
    if (url === "/api/admin/backups" && (init?.method ?? "GET") === "GET") return jsonResponse(backups);
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
  await act(async () => root.render(<BackupManagementDialog close={vi.fn()} />));
  await waitFor(() => expect(host.querySelector(".backup-row")).not.toBeNull());
}

async function restoreToResult(targetDir = restoreCopy.directory) {
  await act(async () => buttonByText("恢复到新目录")!.click());
  await act(async () => setValue(labeled<HTMLInputElement>("恢复目录")!, targetDir));
  await act(async () => buttonByText("确认恢复")!.click());
  await act(async () => host.querySelector<HTMLButtonElement>(".danger-button")!.click());
  await waitFor(() => expect(host.textContent).toContain("恢复副本已生成"));
}

describe("backup management dialog", () => {
  it("lists backups and reports a created package without touching running data", async () => {
    handler = (url, init) => {
      if (url === "/api/admin/backups" && (init?.method ?? "GET") === "GET") return jsonResponse(backups);
      if (url === "/api/admin/backups" && init?.method === "POST") {
        backups = [{ name: created.name, createdAt: "2026-09-17T11:00:00.000Z", valid: true }, ...backups];
        return jsonResponse(created);
      }
      throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
    };
    await renderDialog();
    expect(host.textContent).toContain(backup.name);
    expect(host.textContent).toContain("可用");

    await act(async () => buttonByText("创建备份")!.click());

    await waitFor(() => expect(host.textContent).toContain("备份包已生成"));
    expect(host.textContent).toContain("未影响运行数据");
    expect(host.textContent).toContain(created.name);
    expect(requests.filter((request) => request.url === "/api/admin/backups" && (request.init?.method ?? "GET") === "GET").length).toBeGreaterThanOrEqual(2);
    expect(host.textContent).not.toContain("已切换");
  });

  it("shows a create failure without a fake success state", async () => {
    handler = (url, init) => {
      if (url === "/api/admin/backups" && (init?.method ?? "GET") === "GET") return jsonResponse(backups);
      if (url === "/api/admin/backups" && init?.method === "POST") return failureResponse(409, "存在运行中或未恢复的任务，请稍后再备份");
      throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
    };
    await renderDialog();

    await act(async () => buttonByText("创建备份")!.click());

    await waitFor(() => expect(host.textContent).toContain("存在运行中或未恢复的任务"));
    expect(host.textContent).not.toContain("备份包已生成");
    expect(buttonByText("创建备份")!.disabled).toBe(false);
  });

  it("requires a new directory and a second confirmation before creating a recovery copy", async () => {
    handler = (url, init) => {
      if (url === "/api/admin/backups" && (init?.method ?? "GET") === "GET") return jsonResponse(backups);
      if (url === "/api/admin/backups/restore" && init?.method === "POST") return jsonResponse(restoreCopy);
      throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
    };
    await renderDialog();

    await act(async () => buttonByText("恢复到新目录")!.click());
    await act(async () => buttonByText("确认恢复")!.click());
    expect(host.textContent).toContain("请填写一个新的恢复目录");
    expect(requests.some((request) => request.url.includes("/backups/restore"))).toBe(false);

    await act(async () => setValue(labeled<HTMLInputElement>("恢复目录")!, restoreCopy.directory));
    await act(async () => buttonByText("确认恢复")!.click());
    expect(host.textContent).toContain("不会覆盖当前运行数据");
    await act(async () => host.querySelector<HTMLButtonElement>(".danger-button")!.click());

    await waitFor(() => expect(host.textContent).toContain("恢复副本已生成"));
    expect(host.textContent).toContain("尚未切换运行数据");
    expect(host.textContent).toContain(restoreCopy.directory);
    expect(host.textContent).toContain("本页面不会覆盖当前环境");
    const restoreRequest = requests.find((request) => request.url === "/api/admin/backups/restore")!;
    expect(JSON.parse(String(restoreRequest.init!.body))).toEqual({ name: backup.name, targetDir: restoreCopy.directory });
  });

  it("keeps the restore form and shows the server reason when the target is rejected", async () => {
    handler = (url, init) => {
      if (url === "/api/admin/backups" && (init?.method ?? "GET") === "GET") return jsonResponse(backups);
      if (url === "/api/admin/backups/restore" && init?.method === "POST") return failureResponse(400, "恢复目录必须位于运行数据目录之外");
      throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
    };
    await renderDialog();

    await act(async () => buttonByText("恢复到新目录")!.click());
    await act(async () => setValue(labeled<HTMLInputElement>("恢复目录")!, "E:\\data\\wrong"));
    await act(async () => buttonByText("确认恢复")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".danger-button")!.click());

    await waitFor(() => expect(host.textContent).toContain("恢复目录必须位于运行数据目录之外"));
    expect(labeled<HTMLInputElement>("恢复目录")!.value).toBe("E:\\data\\wrong");
    expect(host.textContent).not.toContain("恢复副本已生成");
  });

  it("verifies the recovery copy and reports each check result", async () => {
    handler = (url, init) => {
      if (url === "/api/admin/backups" && (init?.method ?? "GET") === "GET") return jsonResponse(backups);
      if (url === "/api/admin/backups/restore" && init?.method === "POST") return jsonResponse(restoreCopy);
      if (url === "/api/admin/backups/verify" && init?.method === "POST") return jsonResponse(verification);
      throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
    };
    await renderDialog();
    await restoreToResult();

    await act(async () => buttonByText("验证恢复副本")!.click());

    await waitFor(() => expect(host.textContent).toContain("恢复副本验证通过"));
    expect(host.textContent).toContain("数据库完整性与版本");
    expect(host.textContent).toContain("密钥可用性");
    const verifyRequest = requests.find((request) => request.url === "/api/admin/backups/verify")!;
    expect(JSON.parse(String(verifyRequest.init!.body))).toEqual({ targetDir: restoreCopy.directory });
  });

  it("reports a failed verification without claiming success", async () => {
    const failed: RestoreVerification = {
      directory: restoreCopy.directory,
      ok: false,
      checks: [
        { name: "restored-marker", ok: false, detail: "缺少 RESTORED.json" },
        { name: "database", ok: true, detail: { version: 17 } },
      ],
    };
    handler = (url, init) => {
      if (url === "/api/admin/backups" && (init?.method ?? "GET") === "GET") return jsonResponse(backups);
      if (url === "/api/admin/backups/restore" && init?.method === "POST") return jsonResponse(restoreCopy);
      if (url === "/api/admin/backups/verify" && init?.method === "POST") return jsonResponse(failed);
      throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
    };
    await renderDialog();
    await restoreToResult();

    await act(async () => buttonByText("验证恢复副本")!.click());

    await waitFor(() => expect(host.textContent).toContain("恢复副本验证未通过"));
    expect(host.textContent).toContain("恢复标记");
    expect(host.textContent).toContain("失败");
    expect(host.textContent).not.toContain("恢复副本验证通过");
  });
});