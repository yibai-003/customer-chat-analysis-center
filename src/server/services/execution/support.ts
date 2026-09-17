import { callModelPool, ModelPoolError } from "../model-pool-service";
import type { AnalysisField } from "../../../shared/types";

export function imageDataUrl(imagePath: string, buffer: Buffer) {
  const ext = imagePath.split(".").pop() ?? "png";
  return `data:image/${ext};base64,${buffer.toString("base64")}`;
}

export function dependencyValues(
  field: AnalysisField,
  sourceFields: Record<string, string>,
  context: Record<string, unknown>,
) {
  return Object.fromEntries(field.dependsOn.map((key) => [key, context[key] ?? sourceFields[key]]));
}

export function routedModelSnapshot(routed: Awaited<ReturnType<typeof callModelPool>>) {
  return {
    id: routed.model.id,
    name: routed.model.name,
    model: routed.model.model,
    purpose: routed.model.purpose,
    attempts: routed.attempts,
  };
}

export function failedRouteSnapshot(error: unknown) {
  if (!(error instanceof ModelPoolError)) return {};
  const lastAttempt = error.attempts.at(-1);
  return {
    ...(lastAttempt ? {
      id: lastAttempt.modelConfigId,
      model: lastAttempt.model,
    } : {}),
    attempts: error.attempts,
  };
}
