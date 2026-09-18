import type { Request } from "express";
import { writeAudit } from "./identity-service";

/**
 * Records a successful or failed user action with actor, action, target, outcome,
 * time and safe metadata. Callers must never pass credentials, tokens or file paths.
 */
export function auditRequest(
  req: Request,
  input: {
    action: string;
    outcome?: "success" | "failure";
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const user = req.currentUser;
  writeAudit({
    actorUserId: user?.id,
    actorDisplay: user?.displayName ?? "系统",
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    outcome: input.outcome ?? "success",
    metadata: input.metadata,
    correlationId: req.correlationId,
  });
}