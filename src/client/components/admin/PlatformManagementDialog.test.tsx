// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, Platform } from "../../../shared/types";
import { PlatformManagementDialog } from "./PlatformManagementDialog";

let host: HTMLDivElement;
let root: Root;
let requests: Array<{ url: string; init?: RequestInit }>;

const platform: Platform = {
  id: "platform-1",
  name: "测试平台",
  code: "TEST",
  isEnabled: true,
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z",
};

const candidate: Job = {
  id: "job-legacy",
  originalFilename: "历史接待质检.xlsx",
  sectionId: "reception",
  sectionName: "接待流程质检",
  sectionConfigVersionId: "version-1",
  platformId: null,
  platformCode: null,
  platformName: null,
  status: "completed",
  totalRecords: 2,
  completedRecords: 2,
  failedRecords: 0,
  totalFields: 2,
  completedFields: 2,
  failedFields: 0,
  skippedFields: 0,
  createdAt: "2026-09-20T00:00:00.000Z",
};

function jsonResponse(data: unknown) {
  return { ok: true, json: async () => ({ success: true, data }) } as Response;
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

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  requests = [];
  let candidates = [candidate];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === "/api/admin/platforms") return jsonResponse([platform]);
    if (url === "/api/admin/platform-backfill-candidates") return jsonResponse(candidates);
    if (url === `/api/admin/jobs/${candidate.id}/platform-backfill` && init?.method === "POST") {
      candidates = [];
      return jsonResponse({ ...candidate, platformId: platform.id, platformCode: platform.code, platformName: platform.name });
    }
    throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PlatformManagementDialog", () => {
  it("backfills a historical task once with an audit reason", async () => {
    await act(async () => root.render(<PlatformManagementDialog close={vi.fn()} />));
    await waitFor(() => expect(host.textContent).toContain("历史接待质检.xlsx"));

    const reason = host.querySelector<HTMLInputElement>('[aria-label="历史任务平台补录原因"]')!;
    await act(async () => setValue(reason, "人工核对原始台账"));
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "补录并锁定")!;
    await act(async () => submit.click());

    await waitFor(() => expect(host.textContent).toContain("历史任务平台已补录并锁定"));
    const request = requests.find((item) => item.url.endsWith("/platform-backfill"));
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      platformId: platform.id,
      reason: "人工核对原始台账",
    });
    expect(host.textContent).toContain("没有需要补录平台的历史任务");
  });
});
