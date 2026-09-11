// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImagePreviewDialog } from "./ImagePreviewDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function click(selector: string) {
  const element = host.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`找不到元素：${selector}`);
  act(() => element.click());
}

describe("ImagePreviewDialog", () => {
  it("renders the original image and closes from the close button", () => {
    let closed = false;
    act(() => root.render(
      <ImagePreviewDialog
        src="/api/records/record-1/image"
        alt="聊天截图"
        onClose={() => {
          closed = true;
        }}
      />,
    ));

    const image = host.querySelector<HTMLImageElement>('img[alt="聊天截图"]');
    expect(image?.getAttribute("src")).toBe("/api/records/record-1/image");
    click('button[aria-label="关闭图片预览"]');
    expect(closed).toBe(true);
  });

  it("changes zoom level and resets it for fit-to-window", () => {
    act(() => root.render(
      <ImagePreviewDialog
        src="/api/records/record-1/image"
        alt="聊天截图"
        onClose={() => undefined}
      />,
    ));
    const image = host.querySelector<HTMLImageElement>('img[alt="聊天截图"]')!;

    expect(image.style.transform).toBe("scale(1)");
    click('button[aria-label="放大图片"]');
    expect(image.style.transform).toBe("scale(1.25)");
    click('button[aria-label="缩小图片"]');
    expect(image.style.transform).toBe("scale(1)");
    click('button[aria-label="适应窗口"]');
    expect(image.style.transform).toBe("scale(1)");
  });

  it("closes when Escape is pressed", () => {
    let closed = false;
    act(() => root.render(
      <ImagePreviewDialog
        src="/api/records/record-1/image"
        alt="聊天截图"
        onClose={() => {
          closed = true;
        }}
      />,
    ));

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(closed).toBe(true);
  });
});
