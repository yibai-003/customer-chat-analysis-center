import { assertAnalysisActive } from "../analysis-cancellation";
import { buildFieldMessages } from "../../ai/field-prompt-builder";
import { classifyModelError } from "../../ai/openai-compatible-client";
import { validateFieldResult } from "../../ai/result-validator";
import { createFieldRun } from "../field-run-service";
import { callModelPool } from "../model-pool-service";
import { dependencyValues, failedRouteSnapshot, imageDataUrl, routedModelSnapshot } from "./support";
import { registerFieldExecutionHandler } from "./registry";

registerFieldExecutionHandler({
  type: "ai",
  async run({ recordId, sectionName, record, field, context, image }) {
    const dependencies = dependencyValues(field, record.sourceFields, context);
    const started = Date.now();
    let routed: Awaited<ReturnType<typeof callModelPool>> | undefined;
    try {
      const messages = buildFieldMessages({
        field,
        sectionName,
        sourceFields: record.sourceFields,
        dependencyResults: dependencies,
        imageDataUrl: field.imageEnabled && image ? imageDataUrl(record.imagePath, image) : "",
      });
      routed = await callModelPool(messages, {
        purpose: field.imageEnabled ? "vision" : "text",
        recordId,
        fieldId: field.id,
        operation: field.executionType ?? "ai",
      });
      assertAnalysisActive();
      const checked = validateFieldResult(routed.content, field);
      const status = checked.valid ? "completed" : "needs_review";
      const run = createFieldRun({
        recordId, fieldId: field.id, status, result: checked.result,
        evidence: typeof checked.result.evidence === "string" ? checked.result.evidence : undefined,
        dependencies,
        promptSnapshot: field.prompt, fieldSnapshot: field,
        modelConfigSnapshot: routedModelSnapshot(routed),
        rawResponse: routed.raw, errorMessage: checked.error ?? undefined,
        durationMs: Date.now() - started, usage: routed.usage,
      });
      return { result: checked.result, status, errorMessage: checked.error ?? undefined, run };
    } catch (error) {
      assertAnalysisActive();
      const message = classifyModelError(error).message;
      const run = createFieldRun({
        recordId, fieldId: field.id, status: "failed", result: {},
        dependencies,
        promptSnapshot: field.prompt, fieldSnapshot: field,
        modelConfigSnapshot: routed ? routedModelSnapshot(routed) : failedRouteSnapshot(error),
        rawResponse: routed?.raw,
        errorMessage: message, durationMs: Date.now() - started,
      });
      return { result: {}, status: "failed" as const, errorMessage: message, run };
    }
  },
});
