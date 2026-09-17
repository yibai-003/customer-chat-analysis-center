import { assertAnalysisActive } from "../analysis-cancellation";
import { classifyModelError } from "../../ai/openai-compatible-client";
import { db } from "../../db/client";
import { createFieldRun } from "../field-run-service";
import { callModelPool } from "../model-pool-service";
import {
  attributionFromContext,
  buildLostDealAttributionMessages,
  deriveLostDealFields,
  loadLostDealKnowledgeCandidates,
  parseLostDealAttribution,
} from "../lost-deal-attribution";
import { buildLostDealScriptSuggestion } from "../lost-deal-script-rules";
import { replaceLostDealReasonLinks } from "../lost-deal-capture";
import { dependencyValues, failedRouteSnapshot, routedModelSnapshot } from "./support";
import { registerFieldExecutionHandler } from "./registry";

registerFieldExecutionHandler({
  type: "lost_deal_attribution",
  async run({ recordId, record, field, context }) {
    const dependencies = dependencyValues(field, record.sourceFields, context);
    const started = Date.now();
    let routed: Awaited<ReturnType<typeof callModelPool>> | undefined;
    let invalidResponse: string | undefined;
    try {
      const candidates = loadLostDealKnowledgeCandidates(field);
      if (!candidates.customerReasons.length || !candidates.serviceReasons.length) {
        throw new Error("未成交原因知识库尚未初始化或没有启用条目");
      }
      const summary = typeof dependencies["截图内容总结"] === "string"
        ? dependencies["截图内容总结"] as string
        : "";
      const messages = buildLostDealAttributionMessages({
        field,
        summary,
        sourceFields: record.sourceFields,
        candidates,
      });
      const parseContext = {
        summary,
        sourceFields: record.sourceFields,
      };
      routed = await callModelPool(messages, {
        purpose: "text",
        recordId,
        fieldId: field.id,
        operation: field.executionType ?? "lost_deal_attribution",
        validate: (content) => {
          invalidResponse = content;
          try {
            parseLostDealAttribution(content, candidates, parseContext);
            invalidResponse = undefined;
            return { valid: true };
          } catch {
            return { valid: false };
          }
        },
      });
      assertAnalysisActive();
      const attribution = parseLostDealAttribution(routed.content, candidates, parseContext);
      const result = { [field.key]: attribution };
      const status = attribution.reviewRequired ? "needs_review" as const : "completed" as const;
      const errorMessage = attribution.reviewRequired ? "归因证据不足或置信度偏低，请人工复核" : undefined;
      const selectedRoute = routed;
      const run = db.transaction(() => {
        const created = createFieldRun({
          recordId,
          fieldId: field.id,
          status,
          result,
          evidence: attribution.evidence.join("\n"),
          dependencies,
          promptSnapshot: field.prompt,
          fieldSnapshot: field,
          modelConfigSnapshot: routedModelSnapshot(selectedRoute),
          rawResponse: selectedRoute.raw,
          errorMessage,
          durationMs: Date.now() - started,
          usage: selectedRoute.usage,
        });
        replaceLostDealReasonLinks(recordId, field.id, attribution, Boolean(field.knowledgeSyncEnabled));
        return created;
      })();
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
  type: "lost_deal_derive",
  async run({ recordId, record, field, context }) {
    const dependencies = dependencyValues(field, record.sourceFields, context);
    const started = Date.now();
    const attribution = attributionFromContext(context);
    const derived = deriveLostDealFields(attribution);
    const result = { [field.key]: derived[field.key] ?? "" };
    const run = createFieldRun({
      recordId,
      fieldId: field.id,
      status: attribution.reviewRequired ? "needs_review" : "completed",
      result,
      evidence: attribution.evidence.join("\n"),
      dependencies,
      promptSnapshot: field.prompt,
      fieldSnapshot: field,
      modelConfigSnapshot: {},
      durationMs: Date.now() - started,
    });
    return {
      result,
      status: attribution.reviewRequired ? "needs_review" as const : "completed" as const,
      errorMessage: attribution.reviewRequired ? "归因证据不足或置信度偏低，请人工复核" : undefined,
      run,
    };
  },
});

registerFieldExecutionHandler({
  type: "lost_deal_script",
  async run({ recordId, record, field, context }) {
    const dependencies = dependencyValues(field, record.sourceFields, context);
    const started = Date.now();
    const attribution = attributionFromContext(context);
    const result = {
      [field.key]: buildLostDealScriptSuggestion({
        customerReasons: attribution.customerReasons.map((item) => item.name).filter((name) => name !== "待复核"),
        serviceReasons: attribution.serviceReasons.map((item) => item.name).filter((name) => name !== "待复核"),
        evidence: attribution.evidence,
      }),
    };
    const run = createFieldRun({
      recordId,
      fieldId: field.id,
      status: attribution.reviewRequired ? "needs_review" : "completed",
      result,
      evidence: attribution.evidence.join("\n"),
      dependencies,
      promptSnapshot: field.prompt,
      fieldSnapshot: field,
      modelConfigSnapshot: { strategy: "local_rules" },
      durationMs: Date.now() - started,
    });
    return {
      result,
      status: attribution.reviewRequired ? "needs_review" as const : "completed" as const,
      errorMessage: attribution.reviewRequired ? "归因证据不足或置信度偏低，请人工复核" : undefined,
      run,
    };
  },
});
