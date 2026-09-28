import { useEffect, useRef } from "react";
import { syncCanvasViewport } from "./canvas-runtime";

const MAX_DANDELION_SEEDS = 84;
const DANDELION_CYCLE_MS = 10_000;
const DANDELION_MIN_DISTANCE = 72;
const DANDELION_MAX_DISTANCE = 190;
const DANDELION_MIN_TAIL_LENGTH = 28;
const DANDELION_MAX_TAIL_LENGTH = 64;

const FRAME_INTERVAL_MS = 1_000 / 40;
const ACTIVE_WINDOW_MS = DANDELION_CYCLE_MS * 0.78;
const TAU = Math.PI * 2;

type DandelionSeed = {
  angle: number;
  maxDistance: number;
  delayMs: number;
  size: number;
  drift: number;
  rotation: number;
};

export function createDandelionSeeds(
  count = MAX_DANDELION_SEEDS,
  random: () => number = Math.random,
): DandelionSeed[] {
  return Array.from({ length: count }, (_, index) => ({
    angle: (index / Math.max(count, 1)) * TAU + (random() - 0.5) * 0.22,
    maxDistance: DANDELION_MIN_DISTANCE
      + random() * (DANDELION_MAX_DISTANCE - DANDELION_MIN_DISTANCE),
    delayMs: random() * DANDELION_CYCLE_MS,
    size: 1.05 + random() * 1.4,
    drift: 4 + random() * 15,
    rotation: random() * TAU,
  }));
}

function easeOut(progress: number) {
  return 1 - (1 - progress) ** 3;
}

function drawDandelion(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  seeds: DandelionSeed[],
  timestamp: number,
) {
  const originX = width * 0.75;
  const originY = height * 0.43;

  context.clearRect(0, 0, width, height);
  context.lineCap = "round";

  context.beginPath();
  context.moveTo(originX + width * 0.02, height);
  context.lineTo(originX, originY + 6);
  context.strokeStyle = "rgba(101, 135, 120, 0.38)";
  context.lineWidth = 2;
  context.stroke();

  context.beginPath();
  context.arc(originX, originY, 6, 0, TAU);
  context.fillStyle = "rgba(132, 155, 137, 0.34)";
  context.globalAlpha = 1;
  context.fill();

  for (let ray = 0; ray < 28; ray += 1) {
    const angle = (ray / 28) * TAU;
    const length = 10 + (ray % 3) * 2;
    context.beginPath();
    context.moveTo(originX + Math.cos(angle) * 4, originY + Math.sin(angle) * 4);
    context.lineTo(originX + Math.cos(angle) * length, originY + Math.sin(angle) * length);
    context.strokeStyle = "rgba(111, 143, 156, 0.2)";
    context.lineWidth = 0.7;
    context.stroke();
  }

  for (const seed of seeds) {
    const elapsed = (timestamp + seed.delayMs) % DANDELION_CYCLE_MS;
    if (elapsed >= ACTIVE_WINDOW_MS) continue;

    const progress = elapsed / ACTIVE_WINDOW_MS;
    const distance = 9 + easeOut(progress) * seed.maxDistance;
    const angle = seed.angle + Math.sin(progress * TAU + seed.rotation) * 0.08;
    const wind = Math.sin(progress * Math.PI * 1.4 + seed.rotation) * seed.drift * progress;
    const x = originX + Math.cos(angle) * distance + wind;
    const y = originY + Math.sin(angle) * distance - progress * progress * 22;
    const alpha = Math.sin(progress * Math.PI) ** 0.6;
    const tailLength =
      DANDELION_MIN_TAIL_LENGTH +
      progress * (DANDELION_MAX_TAIL_LENGTH - DANDELION_MIN_TAIL_LENGTH);

    context.globalAlpha = alpha;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(
      x - Math.cos(angle) * tailLength,
      y - Math.sin(angle) * tailLength,
    );
    context.strokeStyle = "rgba(255, 255, 255, 1)";
    context.lineWidth = 1.4;
    context.stroke();

    context.beginPath();
    context.arc(x, y, seed.size, 0, TAU);
    context.fillStyle = "rgba(255, 255, 255, 1)";
    context.fill();
  }

  context.globalAlpha = 1;
}

export function DandelionCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const renderingContext = canvas.getContext("2d");
    if (!renderingContext) return undefined;
    const context: CanvasRenderingContext2D = renderingContext;
    const seeds = createDandelionSeeds();
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = motionPreference.matches;
    let animationFrame = 0;
    let lastFrameAt = 0;
    let renderable = false;
    let width = 0;
    let height = 0;

    const pageIsHidden = () => document.visibilityState === "hidden";

    const cancelFrame = () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    };

    const drawStatic = () => {
      drawDandelion(context, width, height, seeds, 0);
    };

    const requestFrame = () => {
      if (renderable && !animationFrame && !reducedMotion && !pageIsHidden()) {
        animationFrame = window.requestAnimationFrame(drawFrame);
      }
    };

    function drawFrame(timestamp: number) {
      animationFrame = 0;
      if (!renderable || reducedMotion || pageIsHidden()) return;
      if (timestamp - lastFrameAt < FRAME_INTERVAL_MS) {
        requestFrame();
        return;
      }
      lastFrameAt = timestamp;
      drawDandelion(context, width, height, seeds, timestamp);
      requestFrame();
    }

    const resize = () => {
      const viewport = syncCanvasViewport(canvas, context);
      if (!viewport) {
        renderable = false;
        cancelFrame();
        return;
      }

      renderable = true;
      width = viewport.width;
      height = viewport.height;
      drawStatic();
      requestFrame();
    };

    const handleVisibilityChange = () => {
      if (pageIsHidden()) {
        cancelFrame();
        context.clearRect(0, 0, width, height);
        return;
      }
      requestFrame();
    };

    const handleMotionPreference = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      if (reducedMotion) {
        cancelFrame();
        if (renderable) drawStatic();
      } else {
        requestFrame();
      }
    };

    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    motionPreference.addEventListener("change", handleMotionPreference);
    resize();

    return () => {
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      motionPreference.removeEventListener("change", handleMotionPreference);
      cancelFrame();
    };
  }, []);

  return <canvas ref={canvasRef} className="signin-dandelion-canvas" aria-hidden="true" />;
}
