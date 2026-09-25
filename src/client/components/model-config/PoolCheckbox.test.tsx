// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PoolCheckbox } from "./PoolCheckbox";

afterEach(cleanup);

function ControlledPoolCheckbox() {
  const [indeterminate, setIndeterminate] = useState(true);
  return (
    <PoolCheckbox
      label="同步全选"
      checked={false}
      indeterminate={indeterminate}
      onChange={() => {
        flushSync(() => setIndeterminate(false));
      }}
    />
  );
}

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

  it("restores indeterminate after native activation when controlled props stay the same", () => {
    const onChange = vi.fn();
    const props = {
      label: "全选",
      checked: false,
      indeterminate: true,
      onChange,
    };
    const { rerender } = render(<PoolCheckbox {...props} />);
    const checkbox = screen.getByRole("checkbox", { name: "全选" }) as HTMLInputElement;

    fireEvent.click(checkbox);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(checkbox.indeterminate).toBe(true);
    rerender(<PoolCheckbox {...props} />);
    expect(checkbox.indeterminate).toBe(true);
  });

  it("keeps a synchronous parent commit as the final indeterminate state", () => {
    render(<ControlledPoolCheckbox />);
    const checkbox = screen.getByRole("checkbox", { name: "同步全选" }) as HTMLInputElement;
    expect(checkbox.indeterminate).toBe(true);

    fireEvent.click(checkbox);

    expect(checkbox.indeterminate).toBe(false);
  });

  it("passes through disabled state and ignores activation", () => {
    const onChange = vi.fn();
    render(<PoolCheckbox label="禁用成员" checked={false} disabled onChange={onChange} />);
    const checkbox = screen.getByRole("checkbox", { name: "禁用成员" }) as HTMLInputElement;

    expect(checkbox.disabled).toBe(true);
    checkbox.click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses the model-pool checkbox class", () => {
    render(<PoolCheckbox label="选择成员 B" checked={false} onChange={() => undefined} />);
    const checkbox = screen.getByRole("checkbox", { name: "选择成员 B" });

    expect(checkbox.classList.contains("pool-checkbox")).toBe(true);
  });
});
