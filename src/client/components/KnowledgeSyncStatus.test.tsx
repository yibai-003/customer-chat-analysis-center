// @vitest-environment jsdom
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeSyncStatus } from "./KnowledgeSyncStatus";
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const reply = (state: string) => new Response(JSON.stringify({ success: true, data: { state, snapshotReady: state === "synced", github: "not_checked" } }));
describe("knowledge export recovery status", () => {
  it("shows locally saved pending work and retries export without submitting any business save", async () => {
    const fetcher = vi.fn().mockImplementationOnce(async () => reply("pending")).mockImplementationOnce(async () => reply("synced"));
    vi.stubGlobal("fetch", fetcher);
    await act(async () => { render(<KnowledgeSyncStatus />); });
    expect(screen.getByRole("status").textContent).toContain("本地修改已保存");
    await act(async () => { fireEvent.click(screen.getByText("重试快照同步")); });
    expect(fetcher.mock.calls[1][0]).toBe("/api/knowledge-sync/retry");
    expect(fetcher.mock.calls[1][1].method).toBe("POST");
    expect(screen.getByRole("status").textContent).toContain("GitHub 推送状态未检查");
  });
  it("blocks retry on conflict and cancels polling on unmount", async () => {
    vi.useFakeTimers(); const fetcher = vi.fn(async () => reply("conflict")); vi.stubGlobal("fetch", fetcher);
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<KnowledgeSyncStatus />); });
    expect(screen.getByRole<HTMLButtonElement>("button").disabled).toBe(true);
    view.unmount(); await vi.advanceTimersByTimeAsync(10000);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});
