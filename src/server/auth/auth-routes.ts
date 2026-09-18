import express from "express";
import { config } from "../config";
import {
  AUTH_ERRORS,
  createSession,
  hasAnyUser,
  revokeSession,
  verifyCredentials,
} from "./identity-service";
import { capabilitiesForRole } from "./capabilities";
import { clearSessionCookie, optionalAuth, requireAuth, sessionCookie } from "./session-auth";

export function createAuthRouter(): express.Router {
  const router = express.Router();
  const secure = config.sessionCookieSecure;
  const maxAgeSeconds = Math.floor(config.sessionTtlMs / 1000);

  router.post("/login", (req, res) => {
    if (!hasAnyUser()) {
      return res.status(409).json({ success: false, data: null, error: AUTH_ERRORS.NO_ADMIN });
    }
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ success: false, data: null, error: "请输入用户名和密码" });
    }
    let result;
    try {
      result = verifyCredentials(username, password, req.correlationId);
    } catch (error) {
      return res.status(400).json({ success: false, data: null, error: error instanceof Error ? error.message : "用户名或密码格式无效" });
    }
    if (!result.user) {
      return res.status(401).json({ success: false, data: null, error: result.reason });
    }
    const session = createSession(result.user.id, config.sessionTtlMs);
    res.setHeader("Set-Cookie", sessionCookie(session.token, maxAgeSeconds, secure));
    return res.json({
      success: true,
      data: { user: result.user, capabilities: capabilitiesForRole(result.user.role) },
      error: null,
    });
  });

  router.post("/logout", requireAuth(), (req, res) => {
    if (req.sessionCookieToken) revokeSession(req.sessionCookieToken, req.currentUser?.id, req.correlationId);
    res.setHeader("Set-Cookie", clearSessionCookie(secure));
    return res.json({ success: true, data: true, error: null });
  });

  router.get("/me", optionalAuth(), (req, res) => {
    const user = req.currentUser;
    return res.json({
      success: true,
      data: {
        user: user ?? null,
        capabilities: user ? capabilitiesForRole(user.role) : [],
      },
      error: null,
    });
  });

  router.get("/status", (_req, res) => {
    return res.json({ success: true, data: { hasAdmin: hasAnyUser() }, error: null });
  });

  return router;
}