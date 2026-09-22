import { assertAnalysisActive } from "../analysis-cancellation";
import { createFieldRun } from "../field-run-service";
import { matchKnowledgeItem } from "../knowledge/knowledge-match-service";
import { dependencyValues, failedRouteSnapshot, routedModelSnapshot } from "./support";
import { registerFieldExecutionHandler } from "./registry";

registerFieldExecutionHandler({
  type: "knowledge_match",
  async run({ recordId, sectionName, record, field, configVersion, context }) {
    const dependencies = dependencyValues(field, record.sourceFields, context);
    const started = Date.now();
    let matched: Awaited<ReturnType<typeof matchKnowledgeItem>> | undefined;
    try {
      matched = await matchKnowledgeItem({
        recordId,
        field,
        sectionName,
        dependencies,
        knowledgeSnapshot: configVersion.knowledgeSnapshot,
      });
      const run = createFieldRun({
        recordId,
        fieldId: field.id,
        status: matched.status,
        result: matched.result,
        dependencies,
        promptSnapshot: field.prompt,
        fieldSnapshot: field,
        modelConfigSnapshot: matched.route
          ? routedModelSnapshot(matched.route)
          : matched.cached ? { purpose: "text", cached: true } : { purpose: "text" },
        rawResponse: matched.route?.raw,
        errorMessage: matched.errorMessage,
        durationMs: Date.now() - started,
        usage: matched.route?.usage,
      });
      return {
        result: matched.result,
        status: matched.status,
        errorMessage: matched.errorMessage,
        run,
      };
    } catch (error) {
      assertAnalysisActive();
      const message = error instanceof Error ? error.message : "知识匹配失败";
      const run = createFieldRun({
        recordId,
        fieldId: field.id,
        status: "failed",
        result: {},
        dependencies,
        promptSnapshot: field.prompt,
        fieldSnapshot: field,
        modelConfigSnapshot: failedRouteSnapshot(error),
        errorMessage: message,
        durationMs: Date.now() - started,
      });
      return { result: {}, status: "failed" as const, errorMessage: message, run };
    }
  },
});
