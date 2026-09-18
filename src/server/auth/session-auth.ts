import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AUTH_ERRORS, resolveSession } from "./identity-service";
import type { UserProfile } from "../../shared/types";

export const SESSION_COOKIE = "cc_sid";

declare global {
  namespace Express {
    interface Request {
      currentUser?: UserProfile;
      sessionCookieToken?: string;
    }
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(raw);
    } catch {
      result[key] = raw;
    }
  }
  return result;
}

export function readSessionToken(req: Request): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function requireAuth(requireAdmin = false): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = readSessionToken(req);
    const user = token ? resolveSession(token) : undefined;
    if (!user) {
      return res.status(401).json({ success: false, data: null, error: AUTH_ERRORS.LOGIN_REQUIRED });
    }
    if (requireAdmin && user.role !== "admin") {
      return res.status(403).json({ success: false, data: null, error: "需要管理员权限" });
    }
    req.currentUser = user;
    req.sessionCookieToken = token;
    next();
  };
}

/** Resolves the current user when a valid session exists, without rejecting anonymous callers. */
export function optionalAuth(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = readSessionToken(req);
    const user = token ? resolveSession(token) : undefined;
    if (user) {
      req.currentUser = user;
      req.sessionCookieToken = token;
    }
    next();
  };
}