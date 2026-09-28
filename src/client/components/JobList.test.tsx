// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisSection, Job } from "../../shared/types";
import { JobList } from "./JobList";

const jobs = [
  { id: "running", originalFilename: "running.xlsx", status: "processing", sectionId: "reception", sectionName: "接待质检", totalRecords: 4, usageSummary: { callCount: 4, inputTokens: 1200, outputTokens: 300, accountedTokens: 1500, unknownCallCount: 0 } },
  { id: "paused", originalFilename: "paused.xlsx", status: "paused", sectionId: "reception", sectionName: "接待质检", totalRecords: 5, usageSummary: { callCount: 2, inputTokens: 400, outputTokens: 100, accountedTokens: 500, unknownCallCount: 1 } },
  { id: "ready", originalFilename: "ready.xlsx", status: "ready", sectionId: "refund", sectionName: "退款分析", totalRecords: 2, usageSummary: { callCount: 0, inputTokens: 0, outputTokens: 0, accountedTokens: 0, unknownCallCount: 0 } },
] as Job[];
const sections = [
  { id: "reception", name: "接待质检", parentId: "chat", isEnabled: true },
  { id: "refund", name: "退款分析", parentId: "product", isEnabled: true },
] as AnalysisSection[];

let host: HTMLDivElement;
let root: Root;
let onSelect: (id: string) => void;
let onDeleted: (ids: string[]) => void;
let onSectionFilterChange: (sectionId: string) => void;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  onSelect = vi.fn<(id: string) => void>();
  onDeleted = vi.fn<(ids: string[]) => void>();
  onSectionFilterChange = vi.fn<(sectionId: string) => void>();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(
    <JobList
      jobs={jobs}
      sections={sections}
      sectionFilter="all"
      onSectionFilterChange={onSectionFilterChange}
      selectedId="running"
      onSelect={onSelect}
      onDeleted={onDeleted}
    />,
  ));
}

async function select(id: string) {
  const checkbox = host.querySelector<HTMLInputElement>(`input[aria-label="选择任务 ${id}.xlsx"]`)!;
  await act(async () => checkbox.click());
}

describe("JobList batch task controls", () => {
  it("offers pause for selected running tasks and explains the eligible count in a mixed selection", async () => {
    await render();
    await select("running");
    await select("paused");

    expect(host.textContent).toContain("已选择 2 个任务");
    expect(host.textContent).toContain("批量暂停 1 个");
    expect(host.textContent).toContain("其余 1 个将跳过");
  });

  it("submits selected tasks once and shows per-task partial results", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: [
        { jobId: "running", outcome: "success", status: "paused" },
        { jobId: "paused", outcome: "skipped", status: "paused", reason: "任务已暂停" },
      ],
    })));
    vi.stubGlobal("fetch", fetcher);
    await render();
    await select("running");
    await select("paused");

    const pauseButton = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("批量暂停"))!;
    await act(async () => pauseButton.click());

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/jobs/batch-control", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ action: "pause", ids: ["running", "paused"] }),
    }));
    expect(host.textContent).toContain("已暂停 1 个，跳过 1 个，失败 0 个");
    expect(host.textContent).toContain("paused.xlsx：任务已暂停");
  });

  it("offers resume for selected paused tasks and does not offer batch cancel", async () => {
    await render();
    await select("paused");

    expect(host.textContent).toContain("批量继续 1 个");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("批量取消"))).toBe(false);
  });

  it("collects run options before resuming selected tasks", async () => {
    const capacity = {
      metrics: {
        logicalProcessors: 8,
        totalMemoryGb: 16,
        freeMemoryGb: 8,
        diskFreeGb: 120,
        activeJobs: 0,
      },
      recommendation: { concurrency: 3, batchSize: 25 },
      allowedRanges: {
        concurrency: { min: 1, max: 6 },
        batchSize: { min: 5, max: 100 },
      },
      warnings: [],
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/system/analysis-capacity") {
        return new Response(JSON.stringify({ success: true, data: capacity }));
      }
      return new Response(JSON.stringify({
        success: true,
        data: [{ jobId: "paused", outcome: "success", status: "processing" }],
      }));
    });
    vi.stubGlobal("fetch", fetcher);
    await render();
    await select("paused");

    const resumeButton = [...host.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("批量继续"))!;
    await act(async () => resumeButton.click());

    expect(host.textContent).toContain("批量解析运行设置");
    const paidBudget = host.querySelector<HTMLInputElement>("input[aria-label='最大付费 Token']")!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(paidBudget, "6000");
      paidBudget.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirm = [...host.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("按此配置开始解析"))!;
    await act(async () => confirm.click());

    expect(fetcher).toHaveBeenLastCalledWith("/api/jobs/batch-control", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        action: "resume",
        ids: ["paused"],
        concurrency: 3,
        batchSize: 25,
        maxPaidTokens: 6000,
      }),
    }));
  });

  it("drops selections that become hidden after changing filters", async () => {
    await render();
    await select("running");

    const statusFilter = host.querySelector<HTMLButtonElement>("button[aria-label='按任务状态筛选']")!;
    expect(statusFilter.getAttribute("aria-haspopup")).toBe("listbox");
    await act(async () => statusFilter.click());
    const pausedOption = [...host.querySelectorAll<HTMLElement>("[role='option']")]
      .find((option) => option.textContent === "已暂停")!;
    await act(async () => pausedOption.click());

    expect(host.textContent).toContain("未选择任务");
    expect(host.textContent).not.toContain("批量暂停");
  });

  it("opens the task status listbox and closes it with Escape", async () => {
    await render();

    const statusFilter = host.querySelector<HTMLButtonElement>("button[aria-label='按任务状态筛选']")!;
    await act(async () => statusFilter.click());

    expect(statusFilter.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector("[role='listbox'][aria-label='按任务状态筛选选项']")).not.toBeNull();
    expect(host.querySelector("[role='option'][aria-selected='true']")?.textContent).toBe("全部状态");

    await act(async () => {
      statusFilter.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(statusFilter.getAttribute("aria-expanded")).toBe("false");
  });

  it("uses the board filter as navigation and keeps task ownership visible", async () => {
    await act(async () => root.render(
      <JobList
        jobs={jobs}
        sections={sections}
        sectionFilter="reception"
        onSectionFilterChange={onSectionFilterChange}
        selectedId="running"
        onSelect={onSelect}
        onDeleted={onDeleted}
      />,
    ));

    expect(host.textContent).toContain("running.xlsx");
    expect(host.textContent).not.toContain("ready.xlsx");
    expect(host.textContent).toContain("接待质检");

    const sectionFilter = host.querySelector<HTMLButtonElement>("button[aria-label='按解析板块筛选']")!;
    await act(async () => sectionFilter.click());
    const refundOption = [...host.querySelectorAll<HTMLElement>("[role='option']")]
      .find((option) => option.textContent === "退款分析")!;
    await act(async () => refundOption.click());

    expect(onSectionFilterChange).toHaveBeenCalledWith("refund");
  });

  it("renders each task inside its bound board group", async () => {
    await render();

    const receptionGroup = host.querySelector<HTMLElement>("[data-section-task-group='reception']");
    const refundGroup = host.querySelector<HTMLElement>("[data-section-task-group='refund']");
    expect(receptionGroup?.textContent).toContain("running.xlsx");
    expect(receptionGroup?.textContent).toContain("paused.xlsx");
    expect(receptionGroup?.textContent).not.toContain("ready.xlsx");
    expect(refundGroup?.textContent).toContain("ready.xlsx");
    expect(receptionGroup?.textContent).toContain("2K · 6次");
    expect(receptionGroup?.textContent).toContain("有未知用量");
    expect(receptionGroup?.querySelector(".job-usage")?.textContent).toContain("消耗 1.5K Tokens");
  });

  it("shows exact task and board usage without navigating away", async () => {
    await render();

    const taskUsage = host.querySelector<HTMLButtonElement>('[aria-label="查看 running.xlsx 用量"]')!;
    await act(async () => taskUsage.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain("输入 Token1,200");
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain("计费 Token1,500");
    expect(onSelect).not.toHaveBeenCalled();

    await act(async () => taskUsage.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    const boardUsage = host.querySelector<HTMLButtonElement>('[aria-label="查看接待质检板块用量"]')!;
    await act(async () => boardUsage.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));

    const details = document.body.querySelector('[role="tooltip"]')?.textContent;
    expect(details).toContain("输入 Token1,600");
    expect(details).toContain("输出 Token400");
    expect(details).toContain("计费 Token2,000");
    expect(details).toContain("调用次数6");
    expect(details).toContain("未知用量1 次");
  });

  it("keeps the full filename available when the task name is visually clipped", async () => {
    await render();

    expect(host.querySelector(".job-select strong")?.getAttribute("title")).toBe("running.xlsx");
  });
});
