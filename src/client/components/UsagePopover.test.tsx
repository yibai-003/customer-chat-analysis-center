// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsagePopover } from "./UsagePopover";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function renderPopover() {
  await act(async () => root.render(
    <UsagePopover
      ariaLabel="查看 running.xlsx 用量"
      summary={{
        callCount: 4,
        inputTokens: 1200,
        outputTokens: 300,
        accountedTokens: 1500,
        unknownCallCount: 1,
      }}
      compactLabel="消耗 1.5K Tokens · 4 次调用 · 有未知用量"
    />,
  ));
}

describe("UsagePopover", () => {
  it("shows exact usage details on hover and keeps them available while the popup is hovered", async () => {
    await renderPopover();
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="查看 running.xlsx 用量"]')!;

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    const popup = document.body.querySelector<HTMLElement>('[role="tooltip"]');
    expect(popup?.textContent).toContain("输入 Token1,200");
    expect(popup?.textContent).toContain("输出 Token300");
    expect(popup?.textContent).toContain("计费 Token1,500");
    expect(popup?.textContent).toContain("调用次数4");
    expect(popup?.textContent).toContain("未知用量1 次");
  });

  it("keeps a focus-opened popup pinned on the first click and closes it on the second click", async () => {
    await renderPopover();
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="查看 running.xlsx 用量"]')!;

    await act(async () => trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.body.querySelector('[role="tooltip"]')).not.toBeNull();

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.querySelector('[role="tooltip"]')).not.toBeNull();

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("closes a click-pinned popup when the user clicks outside", async () => {
    await renderPopover();
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="查看 running.xlsx 用量"]')!;

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await act(async () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });
});
