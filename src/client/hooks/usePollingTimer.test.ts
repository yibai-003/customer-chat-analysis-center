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
    expect(callback).toHaveBeenCalledTimes(3);
    view.unmount();
    act(() => vi.advanceTimersByTime(3000));
    expect(callback).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
