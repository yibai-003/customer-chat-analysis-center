// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PoolCheckbox } from "./PoolCheckbox";

afterEach(cleanup);

describe("PoolCheckbox", () => {
  it("keeps native checkbox semantics and forwards changes", () => {
    const onChange = vi.fn();
    render(<PoolCheckbox label="选择成员 A" checked={false} onChange={onChange} />);
    const checkbox = screen.getByRole("checkbox", { name: "选择成员 A" });
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("sets and clears the native indeterminate property", () => {
    const { rerender } = render(
      <PoolCheckbox label="全选" checked={false} indeterminate onChange={() => undefined} />,
    );
    const checkbox = screen.getByRole("checkbox", { name: "全选" }) as HTMLInputElement;
    expect(checkbox.indeterminate).toBe(true);
    rerender(<PoolCheckbox label="全选" checked onChange={() => undefined} />);
    expect(checkbox.indeterminate).toBe(false);
    expect(checkbox.checked).toBe(true);
  });
});
