// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePollingTimer } from "./usePollingTimer";

describe("usePollingTimer", () => {
  it("starts and cleans up one timer", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const view = renderHook(({ enabled }) => usePollingTimer(enabled, callback, 1000), { initialProps: { enabled: true } });
    act(() => vi.advanceTimersByTime(3000));
    await act(async () => { await Promise.resolve(); });
    expect(callback).toHaveBeenCalledTimes(3);
    view.unmount();
    act(() => vi.advanceTimersByTime(3000));
    expect(callback).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
  it("does not overlap asynchronous polls", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const callback = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    renderHook(() => usePollingTimer(true, callback, 1000));
    act(() => vi.advanceTimersByTime(3000));
    expect(callback).toHaveBeenCalledTimes(1);
    await act(async () => { release(); await Promise.resolve(); });
    act(() => vi.advanceTimersByTime(1000));
    expect(callback).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
