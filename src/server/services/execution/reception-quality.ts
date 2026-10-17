import {
  buildReceptionScreenshotFactsMessages,
  buildReceptionQualityMessages,
  buildReceptionQualityV2Messages,
  deriveReceptionQualityFields,
  parseReceptionScreenshotFacts,
  parseReceptionQuality,
  parseReceptionQualityV2,
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
import type { SectionConfigVersion } from "../../../shared/types";
import { alignReceptionIssueValues } from "../../../shared/reception-quality-results";
import { receptionBusinessRules, type ReceptionQualityProtocol } from "../section-business-rules";
import { registerFieldExecutionHandler } from "./registry";

interface ReceptionSource {
  screenshotFacts: unknown;
  fieldKey: string;
  analysisProtocol: ReceptionQualityProtocol;
  businessRules: Record<string, unknown>;
  knowledgeSnapshot: SectionConfigVersion["knowledgeSnapshot"];
  sourceFields: Record<string, string>;
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
  prepare({ field, configVersion, dependencies, sourceFields }) {
    const strictProtocol = configVersion.fieldsSnapshot.some((candidate) =>
      candidate.key === "截图内容总结"
      && candidate.executionType === "reception_screenshot_facts");
    return {
      screenshotFacts: dependencies["截图内容总结"],
      fieldKey: field.key,
      analysisProtocol: receptionBusinessRules(configVersion.businessRules).analysisProtocol === "v2"
        ? "v2"
        : strictProtocol ? "strict" : "legacy",
      businessRules: configVersion.businessRules,
      knowledgeSnapshot: configVersion.knowledgeSnapshot,
      sourceFields,
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
    if (source.analysisProtocol === "v2") return buildReceptionQualityV2Messages(messageInput);
    return source.analysisProtocol === "strict"
      ? buildReceptionQualityMessages(messageInput)
      : buildLegacyReceptionQualityMessages(messageInput);
  },
  parse(raw, source) {
    const options = {
      screenshotFacts: source.screenshotFacts,
      businessRules: source.businessRules,
    };
    if (source.analysisProtocol === "v2") {
      return parseReceptionQualityV2(raw, {
        ...options,
        sourceFields: source.sourceFields,
        knowledgeSnapshot: source.knowledgeSnapshot,
      });
    }
    return source.analysisProtocol === "strict"
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
      ...(issue.evidenceRefs?.length
        ? [`结构化证据：${JSON.stringify(issue.evidenceRefs)}`]
        : []),
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
