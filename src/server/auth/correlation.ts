import crypto from "node:crypto";
import type { RequestHandler } from "express";

export const CORRELATION_HEADER = "x-request-id";

/** Trace IDs are opaque ASCII tokens; anything else is replaced, never echoed or stored raw. */
const CORRELATION_PATTERN = /^[A-Za-z0-9._:@+-]{1,128}$/;

export function normalizeCorrelationId(value: unknown): string | undefined {
  return typeof value === "string" && CORRELATION_PATTERN.test(value) ? value : undefined;
}

declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
    }
  }
}

/**
 * Establishes one stable correlation id per request: a valid client-supplied
 * `x-request-id` is kept, everything else (missing, malformed, over-long,
 * control characters, header lists) is replaced with an unpredictable id.
 * The accepted or replacement value is returned in the same response header.
 */
export const correlationId: RequestHandler = (req, res, next) => {
  const provided = normalizeCorrelationId(req.get(CORRELATION_HEADER));
  const value = provided ?? crypto.randomUUID();
  req.correlationId = value;
  res.setHeader(CORRELATION_HEADER, value);
  next();
};
