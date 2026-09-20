import { useEffect, useRef } from "react";

export const MAX_RIPPLES = 3;

const MAX_PIXEL_RATIO = 1.5;
const RIPPLE_LIFETIME_MS = 1_450;
const FRAME_INTERVAL_MS = 1_000 / 40;
const POINTER_INTERVAL_MS = 110;
const POINTER_DISTANCE_PX = 22;
const AMBIENT_INTERVAL_MS = 3_600;

export type WaterRipple = {
  x: number;
  y: number;
  strength: number;
  startedAt: number;
};

export function cappedPixelRatio(pixelRatio: number) {
  return Math.min(Math.max(pixelRatio, 1), MAX_PIXEL_RATIO);
}

export function appendRipple(ripples: WaterRipple[], ripple: WaterRipple) {
  return [...ripples, ripple].slice(-MAX_RIPPLES);
}

function drawRipple(
  context: CanvasRenderingContext2D,
  ripple: WaterRipple,
  timestamp: number,
) {
  const progress = Math.min(Math.max((timestamp - ripple.startedAt) / RIPPLE_LIFETIME_MS, 0), 1);
  const eased = 1 - (1 - progress) ** 3;
  const radius = 18 + eased * 128 * ripple.strength;
  const alpha = (1 - progress) ** 1.7;
  const gradient = context.createRadialGradient(
    ripple.x,
    ripple.y,
    Math.max(0, radius - 22),
    ripple.x,
    ripple.y,
    radius + 12,
  );

  gradient.addColorStop(0, "rgba(255, 255, 255, 0)");
  gradient.addColorStop(0.58, `rgba(235, 242, 226, ${0.08 * alpha})`);
  gradient.addColorStop(0.78, `rgba(105, 132, 112, ${0.16 * alpha})`);
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)");

  context.beginPath();
  context.arc(ripple.x, ripple.y, radius, 0, Math.PI * 2);
  context.fillStyle = gradient;
  context.globalAlpha = 1;
  context.fill();

  for (let ring = 0; ring < 3; ring += 1) {
    context.beginPath();
    context.arc(ripple.x, ripple.y, Math.max(1, radius - ring * 12), 0, Math.PI * 2);
    context.strokeStyle = ring === 1
      ? `rgba(255, 255, 255, ${0.22 * alpha})`
      : `rgba(82, 111, 95, ${0.2 * alpha})`;
    context.lineWidth = ring === 1 ? 1.25 : 0.8;
    context.globalAlpha = 1;
    context.stroke();
  }
}

export function WaterRippleCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const renderingContext = canvas.getContext("2d");
    if (!renderingContext) return undefined;
    const context: CanvasRenderingContext2D = renderingContext;

    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = motionPreference.matches;
    let ripples: WaterRipple[] = [];
    let animationFrame = 0;
    let ambientTimer = 0;
    let lastFrameAt = 0;
    let lastPointerAt = 0;
    let lastPointer: { x: number; y: number } | null = null;
    let width = 0;
    let height = 0;

    const pageIsHidden = () => document.visibilityState === "hidden";

    const requestFrame = () => {
      if (!animationFrame && !reducedMotion && !pageIsHidden()) {
        animationFrame = window.requestAnimationFrame(drawFrame);
      }
    };

    const addRipple = (x: number, y: number, strength: number, startedAt = performance.now()) => {
      ripples = appendRipple(ripples, { x, y, strength, startedAt });
      requestFrame();
    };

    function drawFrame(timestamp: number) {
      animationFrame = 0;
      if (reducedMotion || pageIsHidden()) return;
      if (timestamp - lastFrameAt < FRAME_INTERVAL_MS) {
        requestFrame();
        return;
      }
      lastFrameAt = timestamp;

      context.clearRect(0, 0, width, height);
      ripples = ripples.filter((ripple) => timestamp - ripple.startedAt < RIPPLE_LIFETIME_MS);
      for (const ripple of ripples) drawRipple(context, ripple, timestamp);
      if (ripples.length > 0) requestFrame();
    }

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      const pixelRatio = cappedPixelRatio(window.devicePixelRatio || 1);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);
      ripples = [];
      if (!reducedMotion && !pageIsHidden()) {
        addRipple(width * 0.72, height * 0.38, 0.72);
      }
    };

    const pointerCoordinates = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (reducedMotion || pageIsHidden()) return;
      const point = pointerCoordinates(event);
      const now = performance.now();
      const distance = lastPointer
        ? Math.hypot(point.x - lastPointer.x, point.y - lastPointer.y)
        : Number.POSITIVE_INFINITY;
      if (now - lastPointerAt < POINTER_INTERVAL_MS || distance < POINTER_DISTANCE_PX) return;
      lastPointerAt = now;
      lastPointer = point;
      addRipple(point.x, point.y, 0.58, now);
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (reducedMotion || pageIsHidden()) return;
      const point = pointerCoordinates(event);
      addRipple(point.x, point.y, 1.08);
    };

    const handleVisibilityChange = () => {
      if (pageIsHidden()) {
        if (animationFrame) window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
        ripples = [];
        context.clearRect(0, 0, width, height);
        return;
      }
      addRipple(width * 0.66, height * 0.46, 0.66);
    };

    const handleMotionPreference = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      if (reducedMotion) {
        if (animationFrame) window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
        ripples = [];
        context.clearRect(0, 0, width, height);
      } else {
        addRipple(width * 0.66, height * 0.42, 0.66);
      }
    };

    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    motionPreference.addEventListener("change", handleMotionPreference);
    resize();
    ambientTimer = window.setInterval(() => {
      if (!reducedMotion && !pageIsHidden()) {
        addRipple(width * 0.7, height * 0.32, 0.48);
      }
    }, AMBIENT_INTERVAL_MS);

    return () => {
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      motionPreference.removeEventListener("change", handleMotionPreference);
      window.clearInterval(ambientTimer);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  return <canvas ref={canvasRef} className="signin-ripple-canvas" aria-hidden="true" />;
}
