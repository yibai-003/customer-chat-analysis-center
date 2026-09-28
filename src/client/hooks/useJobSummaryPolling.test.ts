// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useJobSummaryPolling } from "./useJobSummaryPolling";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("background job summary polling", () => {
  it("refreshes task summaries while analysis jobs are running and stops on cleanup", async () => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    let completedRecords = 0;
    let status = "processing";
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: [{ id: "background-job", status, completedRecords }],
    })));
    vi.stubGlobal("fetch", fetcher);
    const updateJobs = vi.fn();
    const updateActiveJob = vi.fn();
    const refreshActiveJobRecords = vi.fn(async () => true);
    const { unmount } = renderHook(() => useJobSummaryPolling(
      true,
      "background-job",
      updateJobs,
      updateActiveJob,
      refreshActiveJobRecords,
    ));

    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(updateJobs).toHaveBeenCalledWith([{
      id: "background-job",
      status: "processing",
      completedRecords: 0,
    }]);
    expect(updateActiveJob).toHaveBeenCalledWith({
      id: "background-job",
      status: "processing",
      completedRecords: 0,
    });
    expect(refreshActiveJobRecords).toHaveBeenCalledWith({
      id: "background-job",
      status: "processing",
      completedRecords: 0,
    });

    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(refreshActiveJobRecords).toHaveBeenCalledTimes(1);

    completedRecords = 1;
    status = "completed";
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(refreshActiveJobRecords).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
