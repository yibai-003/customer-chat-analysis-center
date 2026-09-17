import { assertAnalysisActive } from "../analysis-cancellation";
import { classifyModelError } from "../../ai/openai-compatible-client";
import { createFieldRun } from "../field-run-service";
import { callModelPool } from "../model-pool-service";
import {
  buildReceptionQualityMessages,
  deriveReceptionQualityFields,
  parseReceptionQuality,
  receptionQualityFromContext,
} from "../reception-quality";
import { dependencyValues, failedRouteSnapshot, routedModelSnapshot } from "./support";
import { registerFieldExecutionHandler } from "./registry";

registerFieldExecutionHandler({
  type: "reception_quality_analysis",
  async run({ recordId, record, field, context }) {
    const dependencies = dependencyValues(field, record.sourceFields, context);
    const started = Date.now();
    let routed: Awaited<ReturnType<typeof callModelPool>> | undefined;
    let invalidResponse: string | undefined;
    try {
      const messages = buildReceptionQualityMessages({
        field,
        screenshotFacts: dependencies["截图内容总结"],
        sourceFields: record.sourceFields,
      });
      const parseOptions = {
        screenshotFacts: dependencies["截图内容总结"],
      };
      routed = await callModelPool(messages, {
        purpose: "text",
        recordId,
        fieldId: field.id,
        operation: field.executionType ?? "reception_quality_analysis",
        validate: (content) => {
          invalidResponse = content;
          try {
            parseReceptionQuality(content, field.key, parseOptions);
            invalidResponse = undefined;
            return { valid: true };
          } catch {
            return { valid: false };
          }
        },
      });
      assertAnalysisActive();
      const quality = parseReceptionQuality(routed.content, field.key, parseOptions);
      const result = { [field.key]: quality };
      const status = quality.reviewRequired ? "needs_review" as const : "completed" as const;
      const errorMessage = quality.reviewRequired ? "质检场景或部分项目证据不足，请人工复核" : undefined;
      const evidence = [...quality.preSaleIssues, ...quality.afterSaleIssues].map((issue) => issue.evidence).join("\n");
      const run = createFieldRun({
        recordId,
        fieldId: field.id,
        status,
        result,
        evidence,
        dependencies,
        promptSnapshot: field.prompt,
        fieldSnapshot: field,
        modelConfigSnapshot: routedModelSnapshot(routed),
        rawResponse: routed.raw,
        errorMessage,
        durationMs: Date.now() - started,
        usage: routed.usage,
      });
      return { result, status, errorMessage, run };
    } catch (error) {
      assertAnalysisActive();
      const message = classifyModelError(error).message;
      const run = createFieldRun({
        recordId,
        fieldId: field.id,
        status: "failed",
        result: {},
        dependencies,
        promptSnapshot: field.prompt,
        fieldSnapshot: field,
        modelConfigSnapshot: routed ? routedModelSnapshot(routed) : failedRouteSnapshot(error),
        rawResponse: routed?.raw ?? invalidResponse,
        errorMessage: message,
        durationMs: Date.now() - started,
      });
      return { result: {}, status: "failed" as const, errorMessage: message, run };
    }
  },
});

registerFieldExecutionHandler({
  type: "reception_quality_derive",
  async run({ recordId, record, field, context }) {
    const dependencies = dependencyValues(field, record.sourceFields, context);
    const started = Date.now();
    const quality = receptionQualityFromContext(context);
    const result = { [field.key]: deriveReceptionQualityFields(quality)[field.key] ?? "" };
    const status = quality.reviewRequired ? "needs_review" as const : "completed" as const;
    const errorMessage = quality.reviewRequired ? "质检场景或部分项目证据不足，请人工复核" : undefined;
    const run = createFieldRun({
      recordId,
      fieldId: field.id,
      status,
      result,
      evidence: [...quality.preSaleIssues, ...quality.afterSaleIssues].map((issue) => issue.evidence).join("\n"),
      dependencies,
      promptSnapshot: field.prompt,
      fieldSnapshot: field,
      modelConfigSnapshot: { strategy: "local_rules" },
      errorMessage,
      durationMs: Date.now() - started,
    });
    return { result, status, errorMessage, run };
  },
});
