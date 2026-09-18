// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { capabilitiesForRole, type Job, type UserRole } from "../../shared/types";
import { notifyAccessDenied } from "./session";

const section = { id: "reception", parentId: "chat", name: "接待分析", prompt: "", outputSchema: [], sortOrder: 1, isEnabled: true };
const parentSection = { ...section, id: "chat", parentId: null, name: "聊天问题", sortOrder: 0 };
const job: Job = {
  id: "job-1",
  originalFilename: "first.xlsx",
  sectionId: "reception",
  sectionName: "接待分析",
  status: "ready",
  totalRecords: 1,
  completedRecords: 0,
  failedRecords: 0,
  totalFields: 0,
  completedFields: 0,
  failedFields: 0,
  skippedFields: 0,
  createdAt: "2026-09-17T00:00:00.000Z",
};
const record = {
  id: "r1",
  rowNumber: 1,
  sheetName: "Sheet1",
  sourceFields: { 客服: "小张" },
  imageUrl: "/api/records/r1/image",
  status: "completed",
  reviewStatus: "pending",
};
const recordDetail = { ...record, jobId: "job-1", imagePath: "", humanResult: null, reviewNote: "", sectionReviews: {}, analysisRuns: [], fieldRuns: [] };
const field = { id: "f1", sectionId: "reception", key: "结论", label: "结论", type: "string", prompt: "", required: false, imageEnabled: false, dependsOn: [], sortOrder: 0, isEnabled: true, exportEnabled: true };
const capacity = {
  metrics: { logicalProcessors: 8, totalMemoryGb: 16, freeMemoryGb: 8, diskFreeGb: 100, activeJobs: 0 },
  recommendation: { concurrency: 2, batchSize: 20 },
  allowedRanges: { concurrency: { min: 1, max: 6 }, batchSize: { min: 5, max: 100 } },
  warnings: [],
};
const textModel = {
  id: "model-1",
  name: "文本模型",
  baseUrl: "https://models.example/v1",
  maskedApiKey: "***",
  model: "text-model",
  supportsVision: false,
  temperature: 0,
  maxTokens: 1000,
  isDefault: true,
  purpose: "text",
  isPurposeDefault: true,
  isEnabled: true,
  poolEnabled: true,
  capabilityEligible: true,
  quotaBlocked: false,
  billingMode: "free",
  qualityTier: "A",
  priority: 0,
  thinkingMode: false,
  memberType: "general",
  quotaUsedTokens: 0,
  quotaSafetyRatio: 1,
  consecutiveFailures: 0,
};

function jsonResponse(data: unknown) {
  return { ok: true, json: async () => ({ success: true, data }) } as Response;
}

let host: HTMLDivElement;
let root: Root;
let rootMounted = false;

function sessionResponse(role: UserRole) {
  const user = {
    id: `${role}-1`,
    organizationId: "org-default",
    username: `${role}-user`,
    displayName: `${role} 用户`,
    role,
    isEnabled: true,
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  };
  return jsonResponse({ user, capabilities: capabilitiesForRole(role) });
}

function installFetch(role: UserRole) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/auth/me") return sessionResponse(role);
    if (url === "/api/jobs") return jsonResponse([job]);
    if (url === "/api/sections") return jsonResponse([parentSection, section]);
    if (url === "/api/sections/reception/fields") return jsonResponse([field]);
    if (url === "/api/model-configs") return jsonResponse([textModel]);
    if (url === "/api/jobs/job-1") return jsonResponse(job);
    if (url.startsWith("/api/jobs/job-1/records")) return jsonResponse({ items: [record], total: 1, page: 1, pageSize: 50 });
    if (url === "/api/records/r1") return jsonResponse(recordDetail);
    if (url === "/api/knowledge-sync") return jsonResponse({ state: "synced", snapshotReady: true, github: "not_checked" });
    if (url === "/api/system/analysis-capacity") return jsonResponse(capacity);
    return jsonResponse([]);
  }));
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

function elementByText(text: string) {
  return [...host.querySelectorAll<HTMLElement>("button, label")].find((element) => element.textContent?.trim() === text);
}

function expectButtonVisible(text: string, visible: boolean) {
  expect(Boolean(elementByText(text)), text).toBe(visible);
}

async function renderWorkspace(role: UserRole) {
  installFetch(role);
  await act(async () => root.render(<App />));
  await waitFor(() => expect(host.querySelector(".user-chip")).not.toBeNull());
}

async function openRecordDetail() {
  await act(async () => host.querySelector<HTMLButtonElement>(".record-select")!.click());
  await waitFor(() => expect(host.textContent).toContain("RECORD 01"));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  rootMounted = true;
});

afterEach(async () => {
  if (rootMounted) await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("capability gating in the workspace", () => {
  it("shows operators import, analysis and export controls but hides review and configuration", async () => {
    await renderWorkspace("operator");
    expectButtonVisible("＋ 导入 Excel", true);
    expectButtonVisible("批量解析 →", true);
    expectButtonVisible("导出结果 ↗", true);
    expectButtonVisible("板块配置", false);
    expectButtonVisible("模型配置", false);
    expectButtonVisible("账号管理", false);
    expectButtonVisible("审计日志", false);
    expectButtonVisible("备份管理", false);
    expect(host.querySelector('input[aria-label^="选择记录"]')).not.toBeNull();

    await openRecordDetail();
    expectButtonVisible("开始解析 →", true);
    expectButtonVisible("保存复核", false);
    const textareas = [...host.querySelectorAll<HTMLTextAreaElement>(".detail-scroll textarea")];
    expect(textareas.length).toBeGreaterThan(0);
    expect(textareas.every((textarea) => textarea.readOnly)).toBe(true);
  });

  it("shows reviewers review and export controls but hides import and analysis", async () => {
    await renderWorkspace("reviewer");
    expectButtonVisible("＋ 导入 Excel", false);
    expectButtonVisible("批量解析 →", false);
    expectButtonVisible("导出结果 ↗", true);
    expect(host.querySelector('input[aria-label^="选择记录"]')).toBeNull();

    await openRecordDetail();
    expectButtonVisible("保存复核", true);
    expectButtonVisible("开始解析 →", false);
    const textareas = [...host.querySelectorAll<HTMLTextAreaElement>(".detail-scroll textarea")];
    expect(textareas.length).toBeGreaterThan(0);
    expect(textareas.every((textarea) => textarea.readOnly === false)).toBe(true);
  });

  it("keeps read-only users to viewing without import, analysis, export, review or configuration", async () => {
    await renderWorkspace("readonly");
    expectButtonVisible("＋ 导入 Excel", false);
    expectButtonVisible("批量解析 →", false);
    expectButtonVisible("导出结果 ↗", false);
    expectButtonVisible("板块配置", false);
    expectButtonVisible("模型配置", false);
    expectButtonVisible("账号管理", false);
    expectButtonVisible("审计日志", false);
    expectButtonVisible("备份管理", false);
    expect(host.textContent).not.toContain("全选当前任务");
    expect(host.querySelector('input[aria-label^="选择任务"]')).toBeNull();

    await openRecordDetail();
    expectButtonVisible("保存复核", false);
    expectButtonVisible("开始解析 →", false);
    expect(host.querySelector(".detail-actions")).toBeNull();
    expect([...host.querySelectorAll<HTMLTextAreaElement>(".detail-scroll textarea")].every((textarea) => textarea.readOnly)).toBe(true);
  });

  it("shows configuration entries only to configuration and admin roles", async () => {
    await renderWorkspace("config");
    expectButtonVisible("板块配置", true);
    expectButtonVisible("模型配置", true);
    expectButtonVisible("＋ 导入 Excel", false);
    expectButtonVisible("批量解析 →", false);
    expectButtonVisible("导出结果 ↗", false);
    expect(host.querySelector('[aria-label="打开接待分析知识库"]')).not.toBeNull();
    expectButtonVisible("账号管理", false);
    expectButtonVisible("审计日志", false);
    expectButtonVisible("备份管理", false);
    expect(host.textContent).not.toContain("全选当前任务");
  });

  it("shows the account, audit and backup management entries only to administrators", async () => {
    await renderWorkspace("admin");
    expectButtonVisible("账号管理", true);
    expectButtonVisible("审计日志", true);
    expectButtonVisible("备份管理", true);
    expectButtonVisible("板块配置", true);
  });

  it("clears privileged dialogs and reports an access error when the server denies an action", async () => {
    await renderWorkspace("operator");
    await act(async () => elementByText("批量解析 →")!.click());
    await waitFor(() => expect(host.textContent).toContain("批量解析运行设置"));

    await act(async () => notifyAccessDenied("当前角色无权执行此操作"));

    expect(host.textContent).not.toContain("批量解析运行设置");
    await waitFor(() => expect(host.querySelector(".notice")?.textContent).toContain("当前角色无权执行此操作"));
  });
});