// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisCapacity, AnalysisSection, Job, RecordDetail, RecordPage, RecordSummary } from "../shared/types";
import App from "./App";
import { formatFieldResult } from "./App";

describe("field result formatting", () => {
  it("renders structured results as readable JSON", () => {
    expect(formatFieldResult({ 问题现象: "未说明" })).toBe('{\n  "问题现象": "未说明"\n}');
  });
});

const section: AnalysisSection = {
  id: "reception",
  parentId: "service",
  name: "接待分析",
  prompt: "",
  outputSchema: [],
  sortOrder: 1,
  isEnabled: true,
};

const jobs: Job[] = [
  {
    id: "job-1",
    originalFilename: "first.xlsx",
    sectionId: section.id,
    sectionName: section.name,
    status: "ready",
    totalRecords: 120,
    completedRecords: 0,
    failedRecords: 0,
    totalFields: 0,
    completedFields: 0,
    failedFields: 0,
    skippedFields: 0,
    createdAt: "2026-09-10T01:00:00.000Z",
  },
  {
    id: "job-2",
    originalFilename: "second.xlsx",
    sectionId: section.id,
    sectionName: section.name,
    status: "ready",
    totalRecords: 20,
    completedRecords: 0,
    failedRecords: 0,
    totalFields: 0,
    completedFields: 0,
    failedFields: 0,
    skippedFields: 0,
    createdAt: "2026-09-10T02:00:00.000Z",
  },
];

const capacity: AnalysisCapacity = {
  metrics: {
    logicalProcessors: 20,
    totalMemoryGb: 16,
    freeMemoryGb: 8,
    diskFreeGb: 100,
    activeJobs: 0,
  },
  recommendation: {
    concurrency: 3,
    batchSize: 30,
  },
  allowedRanges: {
    concurrency: { min: 1, max: 6 },
    batchSize: { min: 5, max: 100 },
  },
  warnings: [],
};

function record(id: string, rowNumber: number, status: RecordSummary["status"] = "completed"): RecordSummary {
  return {
    id,
    rowNumber,
    sheetName: "Sheet1",
    sourceFields: { 客服: `客服 ${rowNumber}` },
    imageUrl: `/api/records/${id}/image`,
    status,
    reviewStatus: "pending",
  };
}

function page(items: RecordSummary[], total: number, pageNumber: number): RecordPage {
  return { items, total, page: pageNumber, pageSize: 50 };
}

function detail(summary: RecordSummary, jobId = "job-1"): RecordDetail {
  return {
    ...summary,
    jobId,
    imagePath: `E:\\images\\${summary.id}.png`,
    humanResult: null,
    reviewNote: "",
    sectionReviews: {},
    analysisRuns: [],
    fieldRuns: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let host: HTMLDivElement;
let root: Root;
let rootMounted: boolean;
let requests: string[];
let requestOptions: Array<{ url: string; init?: RequestInit }>;
let responseFor: (url: string, init?: RequestInit) => Response | Promise<Response>;

async function waitFor(assertion: () => void, timeout = 2000) {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeout) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
  throw lastError;
}

function jsonResponse(data: unknown) {
  return {
    ok: true,
    json: async () => ({ success: true, data }),
  } as Response;
}

function defaultResponse(url: string): Response {
  if (url === "/api/jobs") return jsonResponse(jobs);
  if (url === "/api/sections") return jsonResponse([
    { ...section, id: "service", parentId: null, name: "客服分析" },
    section,
  ]);
  if (url === "/api/model-configs") return jsonResponse([]);
  if (url === "/api/system/analysis-capacity") return jsonResponse(capacity);
  if (url.endsWith("/fields")) return jsonResponse([]);
  if (url === "/api/jobs/job-1") return jsonResponse(jobs[0]);
  if (url === "/api/jobs/job-2") return jsonResponse(jobs[1]);
  if (url.startsWith("/api/jobs/job-1/records")) {
    const params = new URL(url, "http://localhost").searchParams;
    if (params.get("status") === "failed") {
      return jsonResponse(page([record("filtered-from-server", 101, "completed")], 1, 1));
    }
    if (params.get("page") === "2") {
      return jsonResponse(page([record("page-2", 51)], 120, 2));
    }
    return jsonResponse(page([record("page-1", 1)], 120, 1));
  }
  if (url.startsWith("/api/jobs/job-2/records")) {
    return jsonResponse(page([record("job-2-page-1", 201)], 20, 1));
  }
  if (url === "/api/records/page-1") return jsonResponse(detail(record("page-1", 1)));
  throw new Error(`未处理的请求：${url}`);
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  rootMounted = true;
  requests = [];
  requestOptions = [];
  responseFor = (url) => defaultResponse(url);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    requestOptions.push({ url, init });
    return responseFor(url, init);
  }));
});

afterEach(async () => {
  if (rootMounted) {
    await act(async () => root.unmount());
  }
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openBatchDialog() {
  const analyzeButton = [...host.querySelectorAll<HTMLButtonElement>(".content-actions button")]
    .find((candidate) => candidate.textContent?.includes("批量解析"));
  if (!analyzeButton) throw new Error("找不到批量解析按钮");
  await act(async () => analyzeButton.click());
  await waitFor(() => expect(host.textContent).toContain("批量解析运行设置"));
}

async function confirmBatchAnalysis() {
  await openBatchDialog();
  const confirmButton = [...host.querySelectorAll<HTMLButtonElement>(".analysis-run-modal button")]
    .find((candidate) => candidate.textContent?.includes("按此配置开始解析"));
  if (!confirmButton) throw new Error("找不到批量解析确认按钮");
  await act(async () => confirmButton.click());
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("App record pagination", () => {
  it("loads capacity before batch analysis and posts the confirmed run options", async () => {
    const fallback = responseFor;
    responseFor = (url, init) => {
      if (url === "/api/jobs/job-1/analyze" && init?.method === "POST") {
        return jsonResponse({ ...jobs[0], status: "completed" });
      }
      return fallback(url, init);
    };
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));

    await openBatchDialog();
    expect(requests).toContain("/api/system/analysis-capacity");
    expect(requests).not.toContain("/api/jobs/job-1/analyze");

    const concurrency = host.querySelector<HTMLInputElement>('input[aria-label="AI 并发数"]');
    const batchSize = host.querySelector<HTMLInputElement>('input[aria-label="每批记录数"]');
    if (!concurrency || !batchSize) throw new Error("找不到运行设置输入");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(concurrency, "4");
      concurrency.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(batchSize, "40");
      batchSize.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirmButton = [...host.querySelectorAll<HTMLButtonElement>(".analysis-run-modal button")]
      .find((candidate) => candidate.textContent?.includes("按此配置开始解析"));
    if (!confirmButton) throw new Error("找不到批量解析确认按钮");
    await act(async () => confirmButton.click());

    await waitFor(() => expect(requests).toContain("/api/jobs/job-1/analyze"));
    const analyzeRequest = requestOptions.find((request) => (
      request.url === "/api/jobs/job-1/analyze" && request.init?.method === "POST"
    ));
    expect(JSON.parse(String(analyzeRequest?.init?.body))).toEqual({
      sectionId: "reception",
      concurrency: 4,
      batchSize: 40,
    });
  });

  it("shows the unified message when capacity loading fails", async () => {
    const fallback = responseFor;
    responseFor = (url, init) => (
      url === "/api/system/analysis-capacity"
        ? {
          ok: false,
          json: async () => ({
            success: false,
            data: null,
            error: "系统容量指标暂时不可用",
          }),
        } as Response
        : fallback(url, init)
    );
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));

    const analyzeButton = [...host.querySelectorAll<HTMLButtonElement>(".content-actions button")]
      .find((candidate) => candidate.textContent?.includes("批量解析"));
    if (!analyzeButton) throw new Error("找不到批量解析按钮");
    await act(async () => analyzeButton.click());

    await waitFor(() => expect(host.textContent).toContain("系统容量指标暂时不可用"));
    expect(host.textContent).not.toContain("批量解析运行设置");
    expect(requests).not.toContain("/api/jobs/job-1/analyze");
  });

  it("starts single-record analysis without requesting capacity", async () => {
    const fallback = responseFor;
    responseFor = (url, init) => (
      url === "/api/records/page-1/analyze" && init?.method === "POST"
        ? jsonResponse({})
        : fallback(url, init)
    );
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));
    await act(async () => host.querySelector<HTMLButtonElement>(".record")?.click());
    await waitFor(() => expect(host.textContent).toContain("RECORD 01"));

    const analyzeButton = [...host.querySelectorAll<HTMLButtonElement>(".detail-actions button")]
      .find((candidate) => candidate.textContent?.includes("开始解析"));
    if (!analyzeButton) throw new Error("找不到单条解析按钮");
    await act(async () => analyzeButton.click());

    await waitFor(() => expect(requests).toContain("/api/records/page-1/analyze"));
    expect(requests).not.toContain("/api/system/analysis-capacity");
  });

  it("polls every two seconds and refreshes records only for progress changes and terminal status", async () => {
    const startedJob: Job = { ...jobs[0], status: "processing" };
    const polledJobs: Job[] = [
      startedJob,
      { ...startedJob, completedRecords: 10, completedFields: 10 },
      { ...startedJob, status: "completed", completedRecords: 10, completedFields: 10 },
    ];
    const fallback = responseFor;
    let analysisStarted = false;
    let pollIndex = 0;
    responseFor = (url, init) => {
      if (url === "/api/jobs/job-1/analyze" && init?.method === "POST") {
        analysisStarted = true;
        return jsonResponse(startedJob);
      }
      if (url === "/api/jobs/job-1" && analysisStarted) {
        return jsonResponse(polledJobs[Math.min(pollIndex++, polledJobs.length - 1)]);
      }
      return fallback(url, init);
    };
    const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
    const pollDelays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout === 2000) {
        pollDelays.push(timeout);
        queueMicrotask(() => {
          if (typeof handler === "function") handler(...args);
        });
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }
      return nativeSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout);

    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));
    const initialRecordRequests = requests.filter((url) => url.startsWith(
      "/api/jobs/job-1/records?",
    )).length;

    await confirmBatchAnalysis();

    await waitFor(() => expect(host.textContent).toContain("解析完成，请检查需复核记录"));
    expect(pollDelays).toEqual([2000, 2000, 2000]);
    expect(requests.filter((url) => url.startsWith(
      "/api/jobs/job-1/records?",
    ))).toHaveLength(initialRecordRequests + 2);
  });

  it("keeps paging, pause, and cancel available while batch polling waits", async () => {
    const startedJob: Job = { ...jobs[0], status: "processing" };
    const fallback = responseFor;
    responseFor = (url, init) => {
      if (url === "/api/jobs/job-1/analyze" && init?.method === "POST") {
        return jsonResponse(startedJob);
      }
      return fallback(url, init);
    };
    const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout === 2000) return 1 as unknown as ReturnType<typeof setTimeout>;
      return nativeSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout);

    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));
    await confirmBatchAnalysis();

    await waitFor(() => expect(host.textContent).toContain("暂停"));
    const pauseButton = [...host.querySelectorAll<HTMLButtonElement>(".content-actions button")]
      .find((candidate) => candidate.textContent === "暂停");
    const cancelButton = [...host.querySelectorAll<HTMLButtonElement>(".content-actions button")]
      .find((candidate) => candidate.textContent === "取消");
    expect(pauseButton?.disabled).toBe(false);
    expect(cancelButton?.disabled).toBe(false);

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')?.click();
    });
    await waitFor(() => expect(host.textContent).toContain("记录 51"));
    expect(requests).toContain("/api/jobs/job-1/records?page=2&pageSize=50");
  });

  it("does not schedule another poll when an in-flight response resolves after unmount", async () => {
    const startedJob: Job = { ...jobs[0], status: "processing" };
    const delayedPoll = deferred<Response>();
    const fallback = responseFor;
    let analysisStarted = false;
    responseFor = (url, init) => {
      if (url === "/api/jobs/job-1/analyze" && init?.method === "POST") {
        analysisStarted = true;
        return jsonResponse(startedJob);
      }
      if (url === "/api/jobs/job-1" && analysisStarted) return delayedPoll.promise;
      return fallback(url, init);
    };
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));
    await openBatchDialog();
    vi.useFakeTimers();

    const confirmButton = [...host.querySelectorAll<HTMLButtonElement>(".analysis-run-modal button")]
      .find((candidate) => candidate.textContent?.includes("按此配置开始解析"));
    if (!confirmButton) throw new Error("找不到批量解析确认按钮");
    await act(async () => confirmButton.click());
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(requests.filter((url) => url === "/api/jobs/job-1")).toHaveLength(2);

    await act(async () => root.unmount());
    rootMounted = false;
    await act(async () => {
      delayedPoll.resolve(jsonResponse(startedJob));
      await delayedPoll.promise;
    });
    await act(async () => vi.advanceTimersByTimeAsync(6000));

    expect(requests.filter((url) => url === "/api/jobs/job-1")).toHaveLength(2);
  });

  it.each([
    ["pause", "暂停"],
    ["cancel", "取消"],
  ] as const)("resumes one poll when %s fails and the task is still processing", async (action, label) => {
    const startedJob: Job = { ...jobs[0], status: "processing" };
    const delayedAction = deferred<Response>();
    const fallback = responseFor;
    let analysisStarted = false;
    responseFor = (url, init) => {
      if (url === "/api/jobs/job-1/analyze" && init?.method === "POST") {
        analysisStarted = true;
        return jsonResponse(startedJob);
      }
      if (url === `/api/jobs/job-1/${action}` && init?.method === "POST") {
        return delayedAction.promise;
      }
      if (url === "/api/jobs/job-1" && analysisStarted) return jsonResponse(startedJob);
      return fallback(url, init);
    };
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));
    await openBatchDialog();
    vi.useFakeTimers();

    const confirmButton = [...host.querySelectorAll<HTMLButtonElement>(".analysis-run-modal button")]
      .find((candidate) => candidate.textContent?.includes("按此配置开始解析"));
    if (!confirmButton) throw new Error("找不到批量解析确认按钮");
    await act(async () => confirmButton.click());
    await flushMicrotasks();

    const actionButton = [...host.querySelectorAll<HTMLButtonElement>(".content-actions button")]
      .find((candidate) => candidate.textContent === label);
    if (!actionButton) throw new Error(`找不到${label}按钮`);
    await act(async () => actionButton.click());
    await act(async () => {
      delayedAction.reject(new Error(`${label}失败`));
      await delayedAction.promise.catch(() => undefined);
    });
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(4000));

    expect(requests.filter((url) => url === "/api/jobs/job-1")).toHaveLength(3);
    expect(host.textContent).toContain(`${label}失败`);
  });

  it("resumes one poll when navigation fails and the original task is still processing", async () => {
    const startedJob: Job = { ...jobs[0], status: "processing" };
    const delayedNavigation = deferred<Response>();
    const fallback = responseFor;
    let analysisStarted = false;
    let delayNavigation = false;
    responseFor = (url, init) => {
      if (url === "/api/jobs/job-1/analyze" && init?.method === "POST") {
        analysisStarted = true;
        return jsonResponse(startedJob);
      }
      if (url === "/api/jobs" && delayNavigation) return delayedNavigation.promise;
      if (url === "/api/jobs/job-1" && analysisStarted) return jsonResponse(startedJob);
      return fallback(url, init);
    };
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));
    await openBatchDialog();
    vi.useFakeTimers();

    const confirmButton = [...host.querySelectorAll<HTMLButtonElement>(".analysis-run-modal button")]
      .find((candidate) => candidate.textContent?.includes("按此配置开始解析"));
    if (!confirmButton) throw new Error("找不到批量解析确认按钮");
    await act(async () => confirmButton.click());
    await flushMicrotasks();

    delayNavigation = true;
    const secondJob = [...host.querySelectorAll<HTMLButtonElement>(".job-select")]
      .find((candidate) => candidate.textContent?.includes("second.xlsx"));
    if (!secondJob) throw new Error("找不到第二个任务");
    await act(async () => secondJob.click());
    await act(async () => {
      delayedNavigation.reject(new Error("切换 B 失败"));
      await delayedNavigation.promise.catch(() => undefined);
    });
    await flushMicrotasks();
    await act(async () => vi.advanceTimersByTimeAsync(4000));

    expect(requests.filter((url) => url === "/api/jobs/job-1")).toHaveLength(3);
    expect(host.textContent).toContain("切换 B 失败");
    expect(host.textContent).toContain("first.xlsx");
  });

  it("does not open a stale capacity dialog after switching tasks", async () => {
    const delayedCapacity = deferred<Response>();
    const fallback = responseFor;
    responseFor = (url, init) => (
      url === "/api/system/analysis-capacity"
        ? delayedCapacity.promise
        : fallback(url, init)
    );
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));

    const analyzeButton = [...host.querySelectorAll<HTMLButtonElement>(".content-actions button")]
      .find((candidate) => candidate.textContent?.includes("批量解析"));
    if (!analyzeButton) throw new Error("找不到批量解析按钮");
    await act(async () => analyzeButton.click());
    await waitFor(() => expect(requests).toContain("/api/system/analysis-capacity"));

    const secondJob = [...host.querySelectorAll<HTMLButtonElement>(".job-select")]
      .find((candidate) => candidate.textContent?.includes("second.xlsx"));
    if (!secondJob) throw new Error("找不到第二个任务");
    await act(async () => secondJob.click());
    await waitFor(() => expect(host.textContent).toContain("记录 201"));

    await act(async () => {
      delayedCapacity.resolve(jsonResponse(capacity));
      await delayedCapacity.promise;
    });

    expect(host.textContent).toContain("second.xlsx");
    expect(host.textContent).not.toContain("批量解析运行设置");
  });

  it("loads server pages and resets to page 1 when the status filter changes", async () => {
    await act(async () => root.render(<App />));

    await waitFor(() => expect(host.textContent).toContain("记录 01"));
    expect(requests).toContain("/api/jobs/job-1/records?page=1&pageSize=50");
    expect(host.querySelectorAll(".record")).toHaveLength(1);

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')?.click();
    });
    await waitFor(() => expect(host.textContent).toContain("记录 51"));
    expect(requests).toContain("/api/jobs/job-1/records?page=2&pageSize=50");

    const filter = host.querySelector<HTMLSelectElement>(".content-actions select");
    if (!filter) throw new Error("找不到记录状态筛选");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(filter, "failed");
      filter.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => expect(host.textContent).toContain("记录 101"));
    expect(requests).toContain("/api/jobs/job-1/records?page=1&pageSize=50&status=failed");
  });

  it("resets to page 1 when switching tasks", async () => {
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')?.click();
    });
    await waitFor(() => expect(host.textContent).toContain("记录 51"));

    const secondJob = [...host.querySelectorAll<HTMLButtonElement>(".job-select")]
      .find((candidate) => candidate.textContent?.includes("second.xlsx"));
    if (!secondJob) throw new Error("找不到第二个任务");
    await act(async () => secondJob.click());

    await waitFor(() => expect(host.textContent).toContain("记录 201"));
    expect(requests).toContain("/api/jobs/job-2/records?page=1&pageSize=50");
  });

  it("ignores an older page response after switching tasks", async () => {
    const delayedPage = deferred<Response>();
    const fallback = responseFor;
    responseFor = (url, init) => (
      url === "/api/jobs/job-1/records?page=2&pageSize=50"
        ? delayedPage.promise
        : fallback(url, init)
    );
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')?.click();
    });
    await waitFor(() => expect(requests).toContain("/api/jobs/job-1/records?page=2&pageSize=50"));

    const secondJob = [...host.querySelectorAll<HTMLButtonElement>(".job-select")]
      .find((candidate) => candidate.textContent?.includes("second.xlsx"));
    if (!secondJob) throw new Error("找不到第二个任务");
    await act(async () => secondJob.click());
    await waitFor(() => expect(host.textContent).toContain("记录 201"));

    await act(async () => {
      delayedPage.resolve(jsonResponse(page([record("stale-page-2", 51)], 120, 2)));
      await delayedPage.promise;
    });

    expect(host.textContent).toContain("记录 201");
    expect(host.textContent).not.toContain("记录 51");
  });

  it("ignores an older task refresh after a newer task selection", async () => {
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));

    const delayedJobs = deferred<Response>();
    const fallback = responseFor;
    let delayNextJobsRequest = true;
    responseFor = (url, init) => {
      if (url === "/api/jobs" && delayNextJobsRequest) {
        delayNextJobsRequest = false;
        return delayedJobs.promise;
      }
      return fallback(url, init);
    };

    const taskButtons = [...host.querySelectorAll<HTMLButtonElement>(".job-select")];
    const firstJob = taskButtons.find((candidate) => candidate.textContent?.includes("first.xlsx"));
    const secondJob = taskButtons.find((candidate) => candidate.textContent?.includes("second.xlsx"));
    if (!firstJob || !secondJob) throw new Error("找不到任务按钮");

    await act(async () => secondJob.click());
    await waitFor(() => expect(requests.filter((url) => url === "/api/jobs").length).toBe(2));
    await act(async () => firstJob.click());
    await waitFor(() => expect(requests.filter((url) => (
      url === "/api/jobs/job-1/records?page=1&pageSize=50"
    )).length).toBe(2));

    await act(async () => {
      delayedJobs.resolve(jsonResponse(jobs));
      await delayedJobs.promise;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.textContent).toContain("first.xlsx");
    expect(host.textContent).toContain("记录 01");
    expect(host.textContent).not.toContain("记录 201");
  });

  it("loads the last valid page when the requested page becomes out of range", async () => {
    const fallback = responseFor;
    let pageTwoRequests = 0;
    responseFor = (url, init) => {
      if (url.startsWith("/api/jobs/job-1/records")) {
        const params = new URL(url, "http://localhost").searchParams;
        if (params.get("page") === "3") {
          return jsonResponse(page([], 80, 3));
        }
        if (params.get("page") === "2") {
          pageTwoRequests += 1;
          return pageTwoRequests === 1
            ? jsonResponse(page([record("page-2", 51)], 120, 2))
            : jsonResponse(page([record("last-valid-page", 80)], 80, 2));
        }
      }
      return fallback(url, init);
    };
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')?.click();
    });
    await waitFor(() => expect(host.textContent).toContain("记录 51"));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')?.click();
    });

    await waitFor(() => expect(host.textContent).toContain("记录 80"));
    expect(pageTwoRequests).toBe(2);
    expect(host.textContent).toContain("51-80 / 80");
  });

  it("clears a selected detail when the next page does not contain it", async () => {
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));

    await act(async () => host.querySelector<HTMLButtonElement>(".record")?.click());
    await waitFor(() => expect(host.textContent).toContain("RECORD 01"));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')?.click();
    });

    await waitFor(() => expect(host.textContent).toContain("记录 51"));
    expect(host.querySelector(".detail-empty")).not.toBeNull();
    expect(host.textContent).not.toContain("RECORD 01");
  });

  it("does not restore an old detail response after the filter changes", async () => {
    const delayedDetail = deferred<Response>();
    const fallback = responseFor;
    responseFor = (url, init) => (
      url === "/api/records/page-1" ? delayedDetail.promise : fallback(url, init)
    );
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));

    await act(async () => host.querySelector<HTMLButtonElement>(".record")?.click());
    await waitFor(() => expect(requests).toContain("/api/records/page-1"));

    const filter = host.querySelector<HTMLSelectElement>(".content-actions select");
    if (!filter) throw new Error("找不到记录状态筛选");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(filter, "failed");
      filter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => expect(host.textContent).toContain("记录 101"));

    await act(async () => {
      delayedDetail.resolve(jsonResponse(detail(record("page-1", 1))));
      await delayedDetail.promise;
    });

    expect(host.querySelector(".detail-empty")).not.toBeNull();
    expect(host.textContent).not.toContain("RECORD 01");
  });

  it("keeps the current page when a newer page request fails", async () => {
    const fallback = responseFor;
    responseFor = (url, init) => (
      url === "/api/jobs/job-1/records?page=2&pageSize=50"
        ? Promise.reject(new Error("分页请求失败"))
        : fallback(url, init)
    );
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')?.click();
    });

    await waitFor(() => expect(host.textContent).toContain("分页请求失败"));
    expect(host.textContent).toContain("记录 01");
    expect(host.textContent).toContain("1-50 / 120");
  });

  it("does not refresh an old task when its analysis finishes after task switching", async () => {
    const delayedAnalyze = deferred<Response>();
    const fallback = responseFor;
    responseFor = (url, init) => (
      url === "/api/jobs/job-1/analyze" && init?.method === "POST"
        ? delayedAnalyze.promise
        : fallback(url, init)
    );
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));

    const analyzeButton = [...host.querySelectorAll<HTMLButtonElement>(".content-actions button")]
      .find((candidate) => candidate.textContent?.includes("批量解析"));
    if (!analyzeButton) throw new Error("找不到批量解析按钮");
    await confirmBatchAnalysis();
    await waitFor(() => expect(requests).toContain("/api/jobs/job-1/analyze"));

    const secondJob = [...host.querySelectorAll<HTMLButtonElement>(".job-select")]
      .find((candidate) => candidate.textContent?.includes("second.xlsx"));
    if (!secondJob) throw new Error("找不到第二个任务");
    await act(async () => secondJob.click());
    await waitFor(() => expect(host.textContent).toContain("记录 201"));

    await act(async () => {
      delayedAnalyze.resolve(jsonResponse(jobs[0]));
      await delayedAnalyze.promise;
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(host.textContent).toContain("second.xlsx");
    expect(host.textContent).toContain("记录 201");
    expect(host.textContent).not.toContain("解析完成，请检查需复核记录");
    expect(requests.filter((url) => url === "/api/jobs/job-1")).toHaveLength(1);
  });

  it("does not let a background detail refresh overwrite a local edit", async () => {
    const delayedBackgroundDetail = deferred<Response>();
    const fallback = responseFor;
    let detailRequests = 0;
    responseFor = (url, init) => {
      if (url === "/api/records/page-1") {
        detailRequests += 1;
        return detailRequests === 1
          ? jsonResponse(detail(record("page-1", 1)))
          : delayedBackgroundDetail.promise;
      }
      if (url === "/api/jobs/job-1/analyze" && init?.method === "POST") {
        return jsonResponse(jobs[0]);
      }
      return fallback(url, init);
    };
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));
    await act(async () => host.querySelector<HTMLButtonElement>(".record")?.click());
    await waitFor(() => expect(host.textContent).toContain("RECORD 01"));

    const analyzeButton = [...host.querySelectorAll<HTMLButtonElement>(".content-actions button")]
      .find((candidate) => candidate.textContent?.includes("批量解析"));
    if (!analyzeButton) throw new Error("找不到批量解析按钮");
    await confirmBatchAnalysis();
    await waitFor(() => expect(detailRequests).toBe(2));

    const reviewNote = host.querySelector<HTMLTextAreaElement>(".detail-scroll > .result-field textarea");
    if (!reviewNote) throw new Error("找不到复核备注");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(reviewNote, "本地未保存编辑");
      reviewNote.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(reviewNote.value).toBe("本地未保存编辑");

    await act(async () => {
      delayedBackgroundDetail.resolve(jsonResponse({
        ...detail(record("page-1", 1)),
        reviewNote: "服务端旧值",
      }));
      await delayedBackgroundDetail.promise;
    });

    const currentReviewNote = host.querySelector<HTMLTextAreaElement>(".detail-scroll > .result-field textarea");
    expect(currentReviewNote?.value).toBe("本地未保存编辑");
  });

  it("ignores an older filter response after a newer filter selection", async () => {
    const delayedFailedFilter = deferred<Response>();
    const fallback = responseFor;
    responseFor = (url, init) => (
      url === "/api/jobs/job-1/records?page=1&pageSize=50&status=failed"
        ? delayedFailedFilter.promise
        : fallback(url, init)
    );
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));

    const filter = host.querySelector<HTMLSelectElement>(".content-actions select");
    if (!filter) throw new Error("找不到记录状态筛选");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(filter, "failed");
      filter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => expect(requests).toContain(
      "/api/jobs/job-1/records?page=1&pageSize=50&status=failed",
    ));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(filter, "completed");
      filter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => expect(requests).toContain(
      "/api/jobs/job-1/records?page=1&pageSize=50&status=completed",
    ));

    await act(async () => {
      delayedFailedFilter.resolve(jsonResponse(page([record("old-failed-filter", 101)], 1, 1)));
      await delayedFailedFilter.promise;
    });

    expect(filter.value).toBe("completed");
    expect(host.textContent).toContain("记录 01");
    expect(host.textContent).not.toContain("记录 101");
  });

  it("restores task A operations and busy state after switching to B fails", async () => {
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));

    const delayedJobs = deferred<Response>();
    const fallback = responseFor;
    let failNextJobsRequest = true;
    responseFor = (url, init) => {
      if (url === "/api/jobs" && failNextJobsRequest) {
        failNextJobsRequest = false;
        return delayedJobs.promise;
      }
      if (url === "/api/jobs/job-1/analyze" && init?.method === "POST") {
        return jsonResponse(jobs[0]);
      }
      return fallback(url, init);
    };

    const secondJob = [...host.querySelectorAll<HTMLButtonElement>(".job-select")]
      .find((candidate) => candidate.textContent?.includes("second.xlsx"));
    if (!secondJob) throw new Error("找不到第二个任务");
    await act(async () => secondJob.click());
    await waitFor(() => expect(requests.filter((url) => url === "/api/jobs").length).toBe(2));
    await act(async () => {
      delayedJobs.reject(new Error("切换 B 失败"));
      await delayedJobs.promise.catch(() => undefined);
    });
    await waitFor(() => expect(host.textContent).toContain("切换 B 失败"));
    expect(host.textContent).toContain("记录 01");

    const analyzeButton = [...host.querySelectorAll<HTMLButtonElement>(".content-actions button")]
      .find((candidate) => candidate.textContent?.includes("批量解析"));
    if (!analyzeButton) throw new Error("找不到批量解析按钮");
    await confirmBatchAnalysis();

    await waitFor(() => expect(analyzeButton.disabled).toBe(false));
    expect(host.textContent).toContain("记录 01");
    expect(host.textContent).toContain("解析完成，请检查需复核记录");
  });

  it("keeps task A analysis running when the committed task is selected again", async () => {
    const delayedAnalyze = deferred<Response>();
    const fallback = responseFor;
    responseFor = (url, init) => (
      url === "/api/jobs/job-1/analyze" && init?.method === "POST"
        ? delayedAnalyze.promise
        : fallback(url, init)
    );
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));

    const analyzeButton = [...host.querySelectorAll<HTMLButtonElement>(".content-actions button")]
      .find((candidate) => candidate.textContent?.includes("批量解析"));
    const firstJob = [...host.querySelectorAll<HTMLButtonElement>(".job-select")]
      .find((candidate) => candidate.textContent?.includes("first.xlsx"));
    if (!analyzeButton || !firstJob) throw new Error("找不到任务或批量解析按钮");

    await confirmBatchAnalysis();
    await waitFor(() => expect(requests.filter((url) => (
      url === "/api/jobs/job-1/analyze"
    ))).toHaveLength(1));
    expect(analyzeButton.disabled).toBe(true);

    const jobsRequestsBeforeReselect = requests.filter((url) => url === "/api/jobs").length;
    const recordRequestsBeforeReselect = requests.filter((url) => (
      url === "/api/jobs/job-1/records?page=1&pageSize=50"
    )).length;
    await act(async () => firstJob.click());

    expect(analyzeButton.disabled).toBe(true);
    expect(requests.filter((url) => url === "/api/jobs")).toHaveLength(jobsRequestsBeforeReselect);
    expect(requests.filter((url) => (
      url === "/api/jobs/job-1/records?page=1&pageSize=50"
    ))).toHaveLength(recordRequestsBeforeReselect);
    expect(requests.filter((url) => url === "/api/jobs/job-1/analyze")).toHaveLength(1);

    await act(async () => {
      delayedAnalyze.resolve(jsonResponse(jobs[0]));
      await delayedAnalyze.promise;
    });

    await waitFor(() => expect(analyzeButton.disabled).toBe(false));
    expect(host.textContent).toContain("解析完成，请检查需复核记录");
    expect(requests.filter((url) => url === "/api/jobs/job-1/analyze")).toHaveLength(1);
    expect(requests.filter((url) => url === "/api/jobs")).toHaveLength(
      jobsRequestsBeforeReselect,
    );
    expect(requests.filter((url) => (
      url === "/api/jobs/job-1/records?page=1&pageSize=50"
    ))).toHaveLength(recordRequestsBeforeReselect + 1);
  });

  it("clears task A busy after a pending B navigation is superseded by returning to A", async () => {
    await act(async () => root.render(<App />));
    await waitFor(() => expect(host.textContent).toContain("记录 01"));

    const delayedAnalyze = deferred<Response>();
    const delayedBJobs = deferred<Response>();
    const fallback = responseFor;
    let delayNextJobsRequest = true;
    responseFor = (url, init) => {
      if (url === "/api/jobs/job-1/analyze" && init?.method === "POST") {
        return delayedAnalyze.promise;
      }
      if (url === "/api/jobs" && delayNextJobsRequest) {
        delayNextJobsRequest = false;
        return delayedBJobs.promise;
      }
      return fallback(url, init);
    };

    const analyzeButton = [...host.querySelectorAll<HTMLButtonElement>(".content-actions button")]
      .find((candidate) => candidate.textContent?.includes("批量解析"));
    if (!analyzeButton) throw new Error("找不到批量解析按钮");
    await confirmBatchAnalysis();
    expect(analyzeButton.disabled).toBe(true);

    const taskButtons = [...host.querySelectorAll<HTMLButtonElement>(".job-select")];
    const firstJob = taskButtons.find((candidate) => candidate.textContent?.includes("first.xlsx"));
    const secondJob = taskButtons.find((candidate) => candidate.textContent?.includes("second.xlsx"));
    if (!firstJob || !secondJob) throw new Error("找不到任务按钮");
    await act(async () => secondJob.click());
    await waitFor(() => expect(requests.filter((url) => url === "/api/jobs").length).toBe(2));
    await act(async () => firstJob.click());
    await waitFor(() => expect(requests.filter((url) => (
      url === "/api/jobs/job-1/records?page=1&pageSize=50"
    )).length).toBe(2));

    await waitFor(() => expect(analyzeButton.disabled).toBe(false));
    expect(host.textContent).toContain("first.xlsx");
    expect(host.textContent).toContain("记录 01");

    await act(async () => {
      delayedAnalyze.resolve(jsonResponse(jobs[0]));
      delayedBJobs.resolve(jsonResponse(jobs));
      await Promise.all([delayedAnalyze.promise, delayedBJobs.promise]);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(analyzeButton.disabled).toBe(false);
    expect(host.textContent).toContain("first.xlsx");
    expect(host.textContent).toContain("记录 01");
    expect(host.textContent).not.toContain("记录 201");
  });
});
