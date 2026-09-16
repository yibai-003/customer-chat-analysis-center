import type { AnalysisField, ModelConfig } from "../../shared/types";

export function useModelReadiness(models: ModelConfig[], fields: AnalysisField[]) {
  const needsVision = fields.some((field) => field.isEnabled && field.imageEnabled);
  const needsText = fields.some((field) => field.isEnabled && field.executionType !== "knowledge_extract");
  const eligible = (model: ModelConfig) => model.isEnabled
    && model.poolEnabled
    && model.capabilityEligible
    && !model.quotaBlocked
    && !model.cooldownUntil;
  const hasVision = models.some((model) => model.purpose === "vision" && eligible(model));
  const hasText = models.some((model) => model.purpose === "text" && eligible(model));
  return { needsVision, needsText, ready: (!needsVision || hasVision) && (!needsText || hasText) };
}
