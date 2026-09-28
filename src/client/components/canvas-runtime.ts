const MAX_PIXEL_RATIO = 1.5;

export type CanvasViewport = {
  width: number;
  height: number;
  pixelRatio: number;
};

export function cappedPixelRatio(pixelRatio: number) {
  return Math.min(Math.max(pixelRatio, 1), MAX_PIXEL_RATIO);
}

export function syncCanvasViewport(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
): CanvasViewport | null {
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;

  const pixelRatio = cappedPixelRatio(window.devicePixelRatio || 1);
  canvas.width = Math.round(bounds.width * pixelRatio);
  canvas.height = Math.round(bounds.height * pixelRatio);
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

  return {
    width: bounds.width,
    height: bounds.height,
    pixelRatio,
  };
}
