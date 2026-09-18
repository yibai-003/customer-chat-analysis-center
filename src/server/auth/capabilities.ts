import type { RequestHandler } from "express";
import { capabilitiesForRole, type UserCapability, type UserRole } from "../../shared/types";
import { writeAudit } from "./identity-service";

export { capabilitiesForRole };
export type { UserCapability };

export function roleCan(role: UserRole, capability: UserCapability): boolean {
  return capabilitiesForRole(role).includes(capability);
}

/**
 * Single server-side authorization seam: every protected route names a capability
 * instead of repeating role checks. Denials are audited with actor, action, target
 * and outcome but never with credentials or session identifiers.
 */
export function requireCapability(
  capability: UserCapability,
  action: string,
  targetType: string,
): RequestHandler<Record<string, string>> {
  return (req, res, next) => {
    const user = req.currentUser;
    if (!user) {
      return res.status(401).json({ success: false, data: null, error: "未登录或会话已失效" });
    }
    if (roleCan(user.role, capability)) return next();
    writeAudit({
      actorUserId: user.id,
      actorDisplay: user.displayName,
      action,
      targetType,
      targetId: typeof req.params.id === "string" ? req.params.id : undefined,
      outcome: "failure",
      metadata: { capability, reason: "forbidden", method: req.method, path: req.path },
      correlationId: req.correlationId,
    });
    return res.status(403).json({ success: false, data: null, error: "当前角色无权执行此操作" });
  };
}