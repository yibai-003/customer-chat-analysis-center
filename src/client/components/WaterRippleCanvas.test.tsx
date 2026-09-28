// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RIPPLES,
  WaterRippleCanvas,
  appendRipple,
} from "./WaterRippleCanvas";
import type { WaterRipple } from "./WaterRippleCanvas";

type CanvasContextStub = Pick<
  CanvasRenderingContext2D,
  | "arc"
  | "beginPath"
  | "clearRect"
  | "createRadialGradient"
  | "fill"
  | "setTransform"
  | "stroke"
> & {
  fillStyle: string | CanvasGradient;
  globalAlpha: number;
  lineWidth: number;
  strokeStyle: string | CanvasGradient;
};

let host: HTMLDivElement;
let root: Root;
let context: CanvasContextStub;
let animationFrames: FrameRequestCallback[];
let canvasBounds: DOMRect;

function createBounds(width: number, height: number): DOMRect {
  return {
    width,
    height,
    left: 20,
    top: 30,
    right: 20 + width,
    bottom: 30 + height,
    x: 20,
    y: 30,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  animationFrames = [];
  canvasBounds = createBounds(640, 480);

  const gradient = { addColorStop: vi.fn() } as unknown as CanvasGradient;
  context = {
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    createRadialGradient: vi.fn(() => gradient),
    fill: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    fillStyle: "",
    globalAlpha: 1,
    lineWidth: 1,
    strokeStyle: "",
  };

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => canvasBounds);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WaterRippleCanvas", () => {
  it("keeps only the newest three ripples", () => {
    let ripples: WaterRipple[] = [];
    for (let index = 0; index < MAX_RIPPLES + 2; index += 1) {
      ripples = appendRipple(ripples, { x: index, y: index, strength: 1, startedAt: index });
    }

    expect(ripples).toHaveLength(MAX_RIPPLES);
    expect(ripples.map((ripple) => ripple.x)).toEqual([2, 3, 4]);
  });

  it("renders an inaccessible transparent canvas and draws after pointer movement", async () => {
    await act(async () => root.render(<WaterRippleCanvas />));

    const canvas = host.querySelector<HTMLCanvasElement>(".signin-ripple-canvas");
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
    expect(canvas?.getAttribute("tabindex")).toBeNull();
    expect(canvas?.width).toBe(640);
    expect(canvas?.height).toBe(480);

    await act(async () => {
      const event = new Event("pointermove", { bubbles: true });
      Object.defineProperties(event, {
        clientX: { value: 280 },
        clientY: { value: 210 },
      });
      canvas?.dispatchEvent(event);
      animationFrames.shift()?.(100);
    });

    expect(context.arc).toHaveBeenCalled();
    expect(context.stroke).toHaveBeenCalled();
  });

  it("does not create ripples without layout size and resumes after resize", async () => {
    let ambientCallback: TimerHandler | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((handler) => {
      ambientCallback = handler;
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });
    canvasBounds = createBounds(0, 0);

    await act(async () => root.render(<WaterRippleCanvas />));

    expect(requestAnimationFrame).not.toHaveBeenCalled();

    await act(async () => {
      if (typeof ambientCallback === "function") ambientCallback();
    });
    expect(requestAnimationFrame).not.toHaveBeenCalled();

    canvasBounds = createBounds(640, 480);
    await act(async () => window.dispatchEvent(new Event("resize")));

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it("cancels the active frame when the page becomes hidden", async () => {
    await act(async () => root.render(<WaterRippleCanvas />));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

    await act(async () => document.dispatchEvent(new Event("visibilitychange")));

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  });

  it("does not start animation when reduced motion is requested", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));

    await act(async () => root.render(<WaterRippleCanvas />));

    expect(host.querySelector(".signin-ripple-canvas")).not.toBeNull();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});
