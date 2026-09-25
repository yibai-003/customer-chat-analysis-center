import {
  buildReceptionScreenshotFactsMessages,
  buildReceptionQualityMessages,
  deriveReceptionQualityFields,
  parseReceptionScreenshotFacts,
  parseReceptionQuality,
  type ReceptionScreenshotFacts,
  type ReceptionQualityAnalysis,
} from "../reception-quality";
import {
  buildLegacyReceptionQualityMessages,
  parseLegacyReceptionQuality,
} from "../reception-quality-legacy";
import {
  createStructuredAnalysisHandler,
  createStructuredDeriveHandler,
  type StructuredFieldDefinition,
} from "./structured";
import { alignReceptionIssueValues } from "../../../shared/reception-quality-results";
import { registerFieldExecutionHandler } from "./registry";

interface ReceptionSource {
  screenshotFacts: unknown;
  fieldKey: string;
  strictProtocol: boolean;
  businessRules: Record<string, unknown>;
}

interface ReceptionScreenshotSource {
  fieldKey: string;
  sourceFields: Record<string, string>;
}

const receptionScreenshotDefinition: StructuredFieldDefinition<ReceptionScreenshotSource, ReceptionScreenshotFacts> = {
  key: "截图内容总结",
  prepare({ field, imageDataUrl, sourceFields }) {
    if (!imageDataUrl) throw new Error("截图事实抽取缺少图片");
    return { fieldKey: field.key, sourceFields };
  },
  buildMessages(input) {
    return buildReceptionScreenshotFactsMessages({
      field: input.field,
      sourceFields: input.sourceFields,
      imageDataUrl: input.imageDataUrl,
    });
  },
  parse(raw, source) {
    return parseReceptionScreenshotFacts(raw, source.fieldKey, source.sourceFields);
  },
  derive: () => ({}),
  status: () => ({ status: "completed" }),
  evidence: (facts) => facts.dialogueTurns.map((turn) => `${turn.id} ${turn.speaker}：${turn.text}`).join("\n"),
};

const receptionQualityDefinition: StructuredFieldDefinition<ReceptionSource, ReceptionQualityAnalysis> = {
  key: "统一质检分析",
  prepare({ field, configVersion, dependencies }) {
    return {
      screenshotFacts: dependencies["截图内容总结"],
      fieldKey: field.key,
      strictProtocol: configVersion.fieldsSnapshot.some((candidate) =>
        candidate.key === "截图内容总结"
        && candidate.executionType === "reception_screenshot_facts"),
      businessRules: configVersion.businessRules,
    };
  },
  buildMessages(input, source) {
    const messageInput = {
      field: input.field,
      screenshotFacts: source.screenshotFacts,
      sourceFields: input.sourceFields,
      businessRules: input.configVersion.businessRules,
      knowledgeSnapshot: input.configVersion.knowledgeSnapshot,
    };
    return source.strictProtocol
      ? buildReceptionQualityMessages(messageInput)
      : buildLegacyReceptionQualityMessages(messageInput);
  },
  parse(raw, source) {
    const options = {
      screenshotFacts: source.screenshotFacts,
      businessRules: source.businessRules,
    };
    return source.strictProtocol
      ? parseReceptionQuality(raw, options)
      : parseLegacyReceptionQuality(raw, source.fieldKey, options);
  },
  derive: (quality) => deriveReceptionQualityFields(quality),
  status: (quality) => quality.reviewRequired || alignReceptionIssueValues(quality).hasMismatch
    ? { status: "needs_review", errorMessage: "质检场景或部分项目证据不足，请人工复核" }
    : { status: "completed" },
  evidence: (quality) => [...quality.preSaleIssues, ...quality.afterSaleIssues]
    .map((issue) => [
      ...issue.chatQuotes,
      issue.evidenceExplanation,
      issue.reason,
    ].join("\n")).join("\n"),
};

registerFieldExecutionHandler(createStructuredAnalysisHandler(
  "reception_screenshot_facts",
  receptionScreenshotDefinition,
  { purpose: "vision" },
));
registerFieldExecutionHandler(createStructuredAnalysisHandler("reception_quality_analysis", receptionQualityDefinition));
registerFieldExecutionHandler(createStructuredDeriveHandler("reception_quality_derive", receptionQualityDefinition, { modelConfigSnapshot: { strategy: "local_rules" } }));
