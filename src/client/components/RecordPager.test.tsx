// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordPager } from "./RecordPager";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function button(label: string) {
  const target = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!target) throw new Error(`找不到按钮：${label}`);
  return target;
}

describe("RecordPager", () => {
  it("disables previous on the first page and reports the current record range", () => {
    act(() => root.render(
      <RecordPager
        page={1}
        pageSize={50}
        total={6000}
        onPageChange={() => undefined}
      />,
    ));

    expect(button("上一页").disabled).toBe(true);
    expect(host.textContent).toContain("1-50 / 6000");
  });

  it("requests page 2 when next is clicked from the first page", () => {
    const onPageChange = vi.fn();
    act(() => root.render(
      <RecordPager
        page={1}
        pageSize={50}
        total={6000}
        onPageChange={onPageChange}
      />,
    ));

    act(() => button("下一页").click());

    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("reports the last valid range and disables next for an out-of-range page", () => {
    act(() => root.render(
      <RecordPager
        page={3}
        pageSize={50}
        total={80}
        onPageChange={() => undefined}
      />,
    ));

    expect(host.textContent).toContain("51-80 / 80");
    expect(button("上一页").disabled).toBe(false);
    expect(button("下一页").disabled).toBe(true);
  });

  it("reports an empty range and disables both buttons when there are no records", () => {
    act(() => root.render(
      <RecordPager
        page={5}
        pageSize={50}
        total={0}
        onPageChange={() => undefined}
      />,
    ));

    expect(host.textContent).toContain("0-0 / 0");
    expect(button("上一页").disabled).toBe(true);
    expect(button("下一页").disabled).toBe(true);
  });

  it("reports the final partial page and sends page-size changes", () => {
    const onPageSizeChange = vi.fn();
    act(() => root.render(
      <RecordPager
        page={2}
        pageSize={50}
        total={80}
        onPageChange={() => undefined}
        onPageSizeChange={onPageSizeChange}
      />,
    ));

    expect(host.textContent).toContain("51-80 / 80");
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="每页记录数"]');
    if (!select) throw new Error("找不到每页记录数选择器");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, "100");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(onPageSizeChange).toHaveBeenCalledWith(100);
  });
});
