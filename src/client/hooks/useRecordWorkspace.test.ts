// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRecordWorkspace } from "./useRecordWorkspace";

afterEach(() => vi.unstubAllGlobals());
describe("record request lifecycle", () => {
  it("aborts an obsolete page request and ignores its response without losing the current page", async () => {
    let deliver!: (value: Response) => void; let signal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn().mockImplementationOnce((_url, init) => {
      signal = init.signal; return new Promise(resolve => { deliver = resolve; });
    }).mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [], total: 100, page: 2, pageSize: 50 } }))));
    const notice = vi.fn(); const view = renderHook(() => useRecordWorkspace(notice));
    const query = { jobId: "one", page: 1, pageSize: 50, filter: "all" };
    const old = view.result.current.requestPage(query, "failed");
    await act(async () => { await view.result.current.requestPage({ ...query, page: 2 }, "failed"); });
    expect(signal.aborted).toBe(true);
    await act(async () => { deliver(new Response(JSON.stringify({ data: { items: [], total: 100, page: 1, pageSize: 50 } }))); await old; });
    expect(view.result.current.page).toBe(2); expect(notice).not.toHaveBeenCalled(); view.unmount();
  });
  it("aborts on unmount and does not report a late rejected request", async () => {
    let signal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn((_url, init) => { signal = init.signal; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))); }));
    const notice = vi.fn(); const view = renderHook(() => useRecordWorkspace(notice));
    const pending = view.result.current.requestPage({ jobId: "one", page: 1, pageSize: 50, filter: "all" }, "failed");
    view.unmount(); await pending; expect(signal.aborted).toBe(true); expect(notice).not.toHaveBeenCalled();
  });
});
