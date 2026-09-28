// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectMenu } from "./SelectMenu";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("SelectMenu", () => {
  it("opens a listbox and reports the selected value", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<SelectMenu
      ariaLabel="状态"
      value="all"
      options={[
        { value: "all", label: "全部状态" },
        { value: "paused", label: "已暂停" },
      ]}
      onChange={onChange}
    />));

    const trigger = host.querySelector<HTMLButtonElement>("[aria-label='状态']")!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    await act(async () => trigger.click());

    const selected = host.querySelector<HTMLElement>("[role='option'][aria-selected='true']");
    expect(selected?.textContent).toBe("全部状态");
    const paused = [...host.querySelectorAll<HTMLButtonElement>("[role='option']")]
      .find((option) => option.textContent === "已暂停")!;
    await act(async () => paused.click());

    expect(onChange).toHaveBeenCalledWith("paused");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("supports arrow navigation and Escape", async () => {
    await act(async () => root.render(<SelectMenu
      ariaLabel="板块"
      value="all"
      options={[
        { value: "all", label: "全部板块" },
        { value: "reception", label: "接待质检" },
      ]}
      onChange={vi.fn()}
    />));

    const trigger = host.querySelector<HTMLButtonElement>("[aria-label='板块']")!;
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const firstOption = host.querySelector<HTMLButtonElement>("[role='option']")!;
    await act(async () => {
      firstOption.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement?.textContent).toBe("接待质检");

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("supports Home, End, and Tab without trapping focus", async () => {
    await act(async () => root.render(<SelectMenu
      ariaLabel="板块"
      value="middle"
      options={[
        { value: "first", label: "第一个" },
        { value: "middle", label: "中间" },
        { value: "last", label: "最后一个" },
      ]}
      onChange={vi.fn()}
    />));

    const trigger = host.querySelector<HTMLButtonElement>("[aria-label='板块']")!;
    await act(async () => trigger.click());
    const middleOption = host.querySelector<HTMLButtonElement>(
      "[role='option'][aria-selected='true']",
    )!;
    await act(async () => {
      middleOption.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(document.activeElement?.textContent).toBe("最后一个");

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(document.activeElement?.textContent).toBe("第一个");

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on outside click", async () => {
    await act(async () => root.render(<SelectMenu
      ariaLabel="状态"
      value="all"
      options={[{ value: "all", label: "全部状态" }]}
      onChange={vi.fn()}
    />));

    const trigger = host.querySelector<HTMLButtonElement>("[aria-label='状态']")!;
    await act(async () => trigger.click());
    expect(host.querySelector("[role='listbox']")).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("[role='listbox']")).toBeNull();
  });

  it("does not open when disabled and skips disabled options", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<SelectMenu
      ariaLabel="状态"
      value="all"
      options={[
        { value: "all", label: "全部状态" },
        { value: "paused", label: "已暂停", disabled: true },
        { value: "done", label: "已完成" },
      ]}
      onChange={onChange}
      disabled
    />));

    const trigger = host.querySelector<HTMLButtonElement>("[aria-label='状态']")!;
    expect(trigger.disabled).toBe(true);
    await act(async () => trigger.click());
    expect(host.querySelector("[role='listbox']")).toBeNull();

    await act(async () => root.render(<SelectMenu
      ariaLabel="状态"
      value="all"
      options={[
        { value: "all", label: "全部状态" },
        { value: "paused", label: "已暂停", disabled: true },
        { value: "done", label: "已完成" },
      ]}
      onChange={onChange}
    />));

    const enabledTrigger = host.querySelector<HTMLButtonElement>("[aria-label='状态']")!;
    await act(async () => enabledTrigger.click());
    const firstOption = host.querySelector<HTMLButtonElement>("[role='option']")!;
    await act(async () => {
      firstOption.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement?.textContent).toBe("已完成");
  });

  it("uses native button semantics for keyboard activation", async () => {
    await act(async () => root.render(<SelectMenu
      ariaLabel="状态"
      value="all"
      options={[{ value: "all", label: "全部状态" }]}
      onChange={vi.fn()}
    />));

    const trigger = host.querySelector<HTMLButtonElement>("[aria-label='状态']")!;
    await act(async () => trigger.click());
    const option = host.querySelector<HTMLButtonElement>("[role='option']")!;

    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.type).toBe("button");
    expect(option.tagName).toBe("BUTTON");
    expect(option.type).toBe("button");
  });
});
