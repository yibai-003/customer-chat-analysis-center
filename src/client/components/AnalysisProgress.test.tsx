// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Job } from "../../shared/types";
import { AnalysisProgress } from "./AnalysisProgress";

const job: Job = {
  id: "job-1",
  originalFilename: "sample.xlsx",
  sectionId: "section-1",
  sectionName: "客服分析",
  status: "processing",
  totalRecords: 100,
  completedRecords: 40,
  failedRecords: 5,
  totalFields: 500,
  completedFields: 210,
  failedFields: 12,
  skippedFields: 8,
  createdAt: "2026-09-11T00:00:00.000Z",
};

afterEach(cleanup);

describe("AnalysisProgress", () => {
  it("shows record and field progress bars with live counts", () => {
    render(<AnalysisProgress job={job} />);

    expect(screen.getByText("记录进度")).toBeTruthy();
    expect(screen.getByText("45 / 100")).toBeTruthy();
    expect(screen.getByText("45%")).toBeTruthy();
    expect(screen.getByText("字段进度")).toBeTruthy();
    expect(screen.getByText("210 / 500")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
    expect(document.body.textContent).toContain("失败 5");
    expect(document.body.textContent).toContain("字段失败 12");
    expect(document.body.textContent).toContain("跳过 8");
  });

  it("exposes progress values to assistive technology and handles empty totals", () => {
    render(<AnalysisProgress job={{
      ...job,
      totalRecords: 0,
      completedRecords: 0,
      failedRecords: 0,
      totalFields: 0,
      completedFields: 0,
      failedFields: 0,
      skippedFields: 0,
    }} />);

    const recordProgress = screen.getByRole("progressbar", { name: "记录进度" });
    const fieldProgress = screen.getByRole("progressbar", { name: "字段进度" });
    expect(recordProgress.getAttribute("aria-valuenow")).toBe("0");
    expect(recordProgress.getAttribute("aria-valuemax")).toBe("0");
    expect(fieldProgress.getAttribute("aria-valuenow")).toBe("0");
    expect(fieldProgress.getAttribute("aria-valuemax")).toBe("0");
    expect(screen.getAllByText("0%")).toHaveLength(2);
  });
});
