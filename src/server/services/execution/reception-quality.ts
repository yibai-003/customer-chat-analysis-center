import {
  buildReceptionQualityMessages,
  deriveReceptionQualityFields,
  parseReceptionQuality,
  type ReceptionQualityAnalysis,
} from "../reception-quality";
import {
  createStructuredAnalysisHandler,
  createStructuredDeriveHandler,
  type StructuredFieldDefinition,
} from "./structured";
import { registerFieldExecutionHandler } from "./registry";

interface ReceptionSource {
  screenshotFacts: unknown;
  fieldKey: string;
  businessRules: Record<string, unknown>;
}

const receptionQualityDefinition: StructuredFieldDefinition<ReceptionSource, ReceptionQualityAnalysis> = {
  key: "统一质检分析",
  prepare({ field, configVersion, dependencies }) {
    return {
      screenshotFacts: dependencies["截图内容总结"],
      fieldKey: field.key,
      businessRules: configVersion.businessRules,
    };
  },
  buildMessages(input, source) {
    return buildReceptionQualityMessages({
      field: input.field,
      screenshotFacts: source.screenshotFacts,
      sourceFields: input.sourceFields,
      businessRules: input.configVersion.businessRules,
    });
  },
  parse(raw, source) {
    return parseReceptionQuality(raw, source.fieldKey, {
      screenshotFacts: source.screenshotFacts,
      businessRules: source.businessRules,
    });
  },
  derive: (quality) => deriveReceptionQualityFields(quality),
  status: (quality) => quality.reviewRequired
    ? { status: "needs_review", errorMessage: "质检场景或部分项目证据不足，请人工复核" }
    : { status: "completed" },
  evidence: (quality) => [...quality.preSaleIssues, ...quality.afterSaleIssues]
    .map((issue) => issue.evidence).join("\n"),
};

registerFieldExecutionHandler(createStructuredAnalysisHandler("reception_quality_analysis", receptionQualityDefinition));
registerFieldExecutionHandler(createStructuredDeriveHandler("reception_quality_derive", receptionQualityDefinition, { modelConfigSnapshot: { strategy: "local_rules" } }));
