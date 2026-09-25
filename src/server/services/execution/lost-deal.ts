import {
  buildLostDealAttributionMessages,
  deriveLostDealFields,
  loadLostDealKnowledgeCandidates,
  parseLostDealAttribution,
  type LostDealAttribution,
  type LostDealKnowledgeCandidates,
} from "../lost-deal-attribution";
import { buildLostDealScriptSuggestion } from "../lost-deal-script-rules";
import { replaceLostDealReasonLinks } from "../lost-deal-capture";
import {
  createStructuredAnalysisHandler,
  createStructuredDeriveHandler,
  type StructuredFieldDefinition,
} from "./structured";
import { registerFieldExecutionHandler } from "./registry";

interface LostDealSource {
  candidates: LostDealKnowledgeCandidates;
  summary: string;
  sourceFields: Record<string, string>;
}

const lostDealDefinition: StructuredFieldDefinition<LostDealSource, LostDealAttribution> = {
  key: "未成交归因",
  prepare({ field, configVersion, dependencies, sourceFields }) {
    const candidates = loadLostDealKnowledgeCandidates(field, configVersion.knowledgeSnapshot);
    if (!candidates.customerReasons.length || !candidates.serviceReasons.length) {
      throw new Error("未成交原因知识库尚未初始化或没有启用条目");
    }
    const summary = typeof dependencies["截图内容总结"] === "string"
      ? dependencies["截图内容总结"] as string
      : "";
    return { candidates, summary, sourceFields };
  },
  buildMessages(input, source) {
    return buildLostDealAttributionMessages({
      field: input.field,
      summary: source.summary,
      sourceFields: source.sourceFields,
      candidates: source.candidates,
    });
  },
  parse(raw, source) {
    return parseLostDealAttribution(raw, source.candidates, {
      summary: source.summary,
      sourceFields: source.sourceFields,
    });
  },
  derive: (attribution) => deriveLostDealFields(attribution),
  status: (attribution) => attribution.reviewRequired
    ? { status: "needs_review", errorMessage: "归因证据不足或置信度偏低，请人工复核" }
    : { status: "completed" },
  evidence: (attribution) => attribution.evidence.join("\n"),
  persist({ recordId, fieldId, parsed, knowledgeSyncEnabled, configVersion }) {
    replaceLostDealReasonLinks(
      recordId,
      fieldId,
      parsed,
      knowledgeSyncEnabled,
      configVersion,
    );
  },
};

const lostDealScriptDefinition: StructuredFieldDefinition<LostDealSource, LostDealAttribution> = {
  ...lostDealDefinition,
  derive: (attribution) => ({
    "话术逻辑优化建议": buildLostDealScriptSuggestion({
      customerReasons: attribution.customerReasons.map((item) => item.name).filter((name) => name !== "待复核"),
      serviceReasons: attribution.serviceReasons.map((item) => item.name).filter((name) => name !== "待复核"),
      evidence: attribution.evidence,
    }),
  }),
};

registerFieldExecutionHandler(createStructuredAnalysisHandler("lost_deal_attribution", lostDealDefinition));
registerFieldExecutionHandler(createStructuredDeriveHandler("lost_deal_derive", lostDealDefinition, { modelConfigSnapshot: {} }));
registerFieldExecutionHandler(createStructuredDeriveHandler("lost_deal_script", lostDealScriptDefinition, { modelConfigSnapshot: { strategy: "local_rules" } }));
