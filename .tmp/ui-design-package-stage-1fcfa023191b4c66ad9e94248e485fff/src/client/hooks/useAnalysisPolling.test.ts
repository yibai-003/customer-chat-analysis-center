// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../../shared/types";
import { useAnalysisPolling } from "./useAnalysisPolling";

const job = { id: "one", status: "processing", totalRecords: 2, completedRecords: 0 } as Job;
function setup() {
  const options = { mountedRef: { current: true }, activeJobIdRef: { current: job.id }, jobRef: { current: job },
    commitJobSummary: vi.fn(), refreshCurrentRecordPage: vi.fn(async () => true), setNotice: vi.fn() };
  return { options, view: renderHook(() => useAnalysisPolling(options)) };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("active analysis polling", () => {
  it("serializes requests and stops timers and network requests on unmount", async () => {
    vi.useFakeTimers(); let signal!: AbortSignal;
    const fetcher = vi.fn((_url, init) => { signal = init.signal; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))); });
    vi.stubGlobal("fetch", fetcher);
    const { view } = setup(); act(() => view.result.current.startAnalysisPoll(job));
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    view.unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(signal.aborted).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["sync", "async"])("recovers from a %s callback error and schedules one next poll", async kind => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true, data: { ...job, completedRecords: 1 } }))));
    const { options, view } = setup();
    if (kind === "sync") options.commitJobSummary.mockImplementationOnce(() => { throw new Error("summary failed"); });
    else options.refreshCurrentRecordPage.mockRejectedValueOnce(new Error("page failed"));
    act(() => view.result.current.startAnalysisPoll(job));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(options.setNotice).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(fetch).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(1); view.unmount();
  });
  it("does not overlap a suspended poll with the resumed poll or commit a late response", async () => {
    vi.useFakeTimers(); let deliver!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; }))
      .mockImplementation(async () => new Response(JSON.stringify({ data: job })));
    vi.stubGlobal("fetch", fetcher);
    const { options, view } = setup(); act(() => view.result.current.startAnalysisPoll(job));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    const paused = view.result.current.suspendAnalysisPoll(job.id); view.result.current.resumeAnalysisPoll(paused);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); }); expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { deliver(new Response(JSON.stringify({ data: { ...job, completedRecords: 9 } }))); });
    expect(options.commitJobSummary).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(options.commitJobSummary).toHaveBeenCalledWith(job); view.unmount();
  });
});
