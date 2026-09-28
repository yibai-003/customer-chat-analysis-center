// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DandelionCanvas,
  createDandelionSeeds,
} from "./DandelionCanvas";

type CanvasContextStub = Pick<
  CanvasRenderingContext2D,
  | "arc"
  | "beginPath"
  | "clearRect"
  | "fill"
  | "lineTo"
  | "moveTo"
  | "setTransform"
  | "stroke"
> & {
  fillStyle: string | CanvasGradient;
  globalAlpha: number;
  lineCap: CanvasLineCap;
  lineWidth: number;
  strokeStyle: string | CanvasGradient;
};

let host: HTMLDivElement;
let root: Root;
let context: CanvasContextStub;
let animationFrames: FrameRequestCallback[];
let canvasBounds: DOMRect;
let pathStart: [number, number] | null;
let pathEnd: [number, number] | null;
let strokes: Array<{
  alpha: number;
  from: [number, number] | null;
  lineWidth: number;
  strokeStyle: string | CanvasGradient;
  to: [number, number] | null;
}>;

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
  pathStart = null;
  pathEnd = null;
  strokes = [];

  context = {
    arc: vi.fn(),
    beginPath: vi.fn(() => {
      pathStart = null;
      pathEnd = null;
    }),
    clearRect: vi.fn(),
    fill: vi.fn(),
    lineTo: vi.fn((x: number, y: number) => {
      pathEnd = [x, y];
    }),
    moveTo: vi.fn((x: number, y: number) => {
      pathStart = [x, y];
    }),
    setTransform: vi.fn(),
    stroke: vi.fn(() => {
      strokes.push({
        alpha: context.globalAlpha,
        from: pathStart,
        lineWidth: context.lineWidth,
        strokeStyle: context.strokeStyle,
        to: pathEnd,
      });
    }),
    fillStyle: "",
    globalAlpha: 1,
    lineCap: "butt",
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

describe("DandelionCanvas", () => {
  it("creates a compact seed population with staggered radial motion", () => {
    let randomCalls = 0;
    const seeds = createDandelionSeeds(undefined, () => {
      randomCalls += 1;
      return (randomCalls % 8) / 8;
    });
    const innermostSeed = createDandelionSeeds(1, () => 0)[0];
    const outermostSeed = createDandelionSeeds(1, () => 1)[0];

    expect(seeds).toHaveLength(84);
    expect(innermostSeed?.maxDistance).toBe(72);
    expect(outermostSeed?.maxDistance).toBe(190);
    expect(innermostSeed?.size).toBe(1.05);
    expect(outermostSeed?.size).toBeCloseTo(2.45);
    expect(seeds.every((seed) => seed.maxDistance >= 72 && seed.maxDistance <= 190)).toBe(true);
    expect(seeds.every((seed) => seed.delayMs >= 0 && seed.delayMs < 10_000)).toBe(true);
    expect(new Set(seeds.map((seed) => seed.angle)).size).toBeGreaterThan(1);
  });

  it("draws longer high-contrast white seed trails", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    await act(async () => root.render(<DandelionCanvas />));
    strokes = [];

    await act(async () => {
      animationFrames.shift()?.(1_950);
    });

    const firstSeedTrail = strokes.find((stroke) => (
      stroke.strokeStyle === "rgba(255, 255, 255, 1)"
      && stroke.lineWidth === 1.4
    ));
    expect(firstSeedTrail).toBeDefined();
    expect(firstSeedTrail?.alpha).toBeGreaterThan(0.8);
    expect(firstSeedTrail?.alpha).toBeLessThanOrEqual(1);
    expect(firstSeedTrail?.lineWidth).toBe(1.4);
    expect(firstSeedTrail?.strokeStyle).toBe("rgba(255, 255, 255, 1)");
    expect(Math.hypot(
      (firstSeedTrail?.from?.[0] ?? 0) - (firstSeedTrail?.to?.[0] ?? 0),
      (firstSeedTrail?.from?.[1] ?? 0) - (firstSeedTrail?.to?.[1] ?? 0),
    )).toBeCloseTo(37);
  });

  it("renders an inaccessible canvas and draws the dandelion animation", async () => {
    await act(async () => root.render(<DandelionCanvas />));

    const canvas = host.querySelector<HTMLCanvasElement>(".signin-dandelion-canvas");
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
    expect(canvas?.getAttribute("tabindex")).toBeNull();
    expect(canvas?.width).toBe(640);
    expect(canvas?.height).toBe(480);

    await act(async () => {
      animationFrames.shift()?.(2_000);
    });

    expect(context.arc).toHaveBeenCalled();
    expect(context.stroke).toHaveBeenCalled();
  });

  it("does not animate without layout size and resumes after resize", async () => {
    canvasBounds = createBounds(0, 0);

    await act(async () => root.render(<DandelionCanvas />));

    expect(requestAnimationFrame).not.toHaveBeenCalled();

    canvasBounds = createBounds(640, 480);
    await act(async () => window.dispatchEvent(new Event("resize")));

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it("cancels the active frame when the page becomes hidden", async () => {
    await act(async () => root.render(<DandelionCanvas />));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

    await act(async () => document.dispatchEvent(new Event("visibilitychange")));

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  });

  it("does not start a continuous animation when reduced motion is requested", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));

    await act(async () => root.render(<DandelionCanvas />));

    expect(host.querySelector(".signin-dandelion-canvas")).not.toBeNull();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(context.arc).toHaveBeenCalled();
  });
});
