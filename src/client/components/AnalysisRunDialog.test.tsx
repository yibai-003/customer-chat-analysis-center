// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalysisCapacity } from "../../shared/types";
import { AnalysisRunDialog } from "./AnalysisRunDialog";

const capacity: AnalysisCapacity = {
  metrics: {
    logicalProcessors: 20,
    totalMemoryGb: 15.84,
    freeMemoryGb: 2.42,
    diskFreeGb: null,
    activeJobs: 2,
  },
  recommendation: {
    concurrency: 1,
    batchSize: 10,
  },
  allowedRanges: {
    concurrency: { min: 1, max: 6 },
    batchSize: { min: 5, max: 100 },
  },
  warnings: [
    "当前可用内存低于 3 GB，建议关闭其他应用后再解析。",
    "磁盘指标不可用，无法检查 DATA_DIR 可用空间。",
  ],
};

afterEach(cleanup);

describe("AnalysisRunDialog", () => {
  it("shows capacity metrics, recommendations, warnings, and server input ranges", () => {
    render(<AnalysisRunDialog capacity={capacity} onCancel={() => undefined} onConfirm={() => undefined} />);

    expect(screen.getByText("批量解析运行设置")).toBeTruthy();
    expect(screen.getByText("20 个逻辑处理器")).toBeTruthy();
    expect(screen.getByText("15.84 GB")).toBeTruthy();
    expect(screen.getByText("2.42 GB")).toBeTruthy();
    expect(screen.getByText("不可用")).toBeTruthy();
    expect(screen.getByText("2 个")).toBeTruthy();
    expect(screen.getByText("并发 1 · 每批 10 条")).toBeTruthy();
    expect(screen.getByText(capacity.warnings[0])).toBeTruthy();
    expect(screen.getByText(capacity.warnings[1])).toBeTruthy();

    const concurrency = screen.getByLabelText("AI 并发数") as HTMLInputElement;
    const batchSize = screen.getByLabelText("每批记录数") as HTMLInputElement;
    expect(concurrency.value).toBe("1");
    expect(concurrency.min).toBe("1");
    expect(concurrency.max).toBe("6");
    expect(batchSize.value).toBe("10");
    expect(batchSize.min).toBe("5");
    expect(batchSize.max).toBe("100");
  });

  it("warns above the recommendation and submits the chosen numeric values", () => {
    const onConfirm = vi.fn();
    render(<AnalysisRunDialog capacity={capacity} onCancel={() => undefined} onConfirm={onConfirm} />);

    fireEvent.change(screen.getByLabelText("AI 并发数"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("每批记录数"), { target: { value: "25" } });

    expect(screen.getByText("当前设置高于系统推荐值，可能增加内存占用或模型接口负载。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "按此配置开始解析" }));
    expect(onConfirm).toHaveBeenCalledWith({ concurrency: 3, batchSize: 25 });
  });
});
