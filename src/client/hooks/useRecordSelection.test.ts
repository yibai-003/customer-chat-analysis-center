// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRecordSelection } from "./useRecordSelection";

const scope = { jobId: "job-1", sectionId: "section-1", filter: "all" };

describe("record selection", () => {
  it("toggles single records and whole pages", () => {
    const { result } = renderHook(() => useRecordSelection(scope));

    act(() => result.current.toggle("a"));
    act(() => result.current.toggle("b"));
    expect(result.current.selectedIds).toEqual(["a", "b"]);

    act(() => result.current.toggle("a"));
    expect(result.current.selectedIds).toEqual(["b"]);

    act(() => result.current.togglePage(["b", "c", "d"]));
    expect(result.current.selectedIds).toEqual(["b", "c", "d"]);

    act(() => result.current.togglePage(["b", "c", "d"]));
    expect(result.current.selectedIds).toEqual([]);
  });

  it("keeps selections across pages but clears them when the scope changes", () => {
    const { result, rerender } = renderHook(
      (nextScope) => useRecordSelection(nextScope),
      { initialProps: scope },
    );

    act(() => result.current.toggle("page-1-a"));
    rerender({ ...scope });
    act(() => result.current.toggle("page-2-a"));
    expect(result.current.selectedIds).toEqual(["page-1-a", "page-2-a"]);

    rerender({ ...scope, filter: "failed" });
    expect(result.current.selectedIds).toEqual([]);

    act(() => result.current.toggle("filtered"));
    rerender({ ...scope, jobId: "job-2" });
    expect(result.current.selectedIds).toEqual([]);
  });
});
