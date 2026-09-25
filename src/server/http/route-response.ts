import type { Response } from "express";

export interface RouteResponderOptions {
  resolveStatus?: (error: unknown, fallbackStatus: number) => number;
  resolveMessage?: (error: unknown) => string;
}

function routeOk(res: Response, data: unknown) {
  return res.json({ success: true, data, error: null });
}

export function createRouteResponders(options: RouteResponderOptions = {}) {
  const fail = (res: Response, error: unknown, fallbackStatus = 400) => {
    const status = options.resolveStatus?.(error, fallbackStatus) ?? fallbackStatus;
    const message = options.resolveMessage?.(error)
      ?? (error instanceof Error ? error.message : "请求失败");
    return res.status(status).json({
      success: false,
      data: null,
      error: message,
    });
  };
  return { ok: routeOk, fail };
}
