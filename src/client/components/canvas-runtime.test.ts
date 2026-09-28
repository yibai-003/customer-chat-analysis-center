// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { syncCanvasViewport } from "./canvas-runtime";

function createBounds(width: number, height: number): DOMRect {
  return {
    width,
    height,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("syncCanvasViewport", () => {
  it("returns null without resizing when the canvas has no layout size", () => {
    const canvas = document.createElement("canvas");
    const context = { setTransform: vi.fn() } as unknown as CanvasRenderingContext2D;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(createBounds(0, 0));

    const viewport = syncCanvasViewport(canvas, context);

    expect(viewport).toBeNull();
    expect(context.setTransform).not.toHaveBeenCalled();
  });

  it("caps pixel density and synchronizes the canvas bitmap", () => {
    const canvas = document.createElement("canvas");
    const context = { setTransform: vi.fn() } as unknown as CanvasRenderingContext2D;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(createBounds(640, 480));
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(4);

    const viewport = syncCanvasViewport(canvas, context);

    expect(viewport).toEqual({ width: 640, height: 480, pixelRatio: 1.5 });
    expect(canvas.width).toBe(960);
    expect(canvas.height).toBe(720);
    expect(context.setTransform).toHaveBeenCalledWith(1.5, 0, 0, 1.5, 0, 0);
  });
});
