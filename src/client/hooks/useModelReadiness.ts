import type { AnalysisField, ModelConfig } from "../../shared/types";

export function useModelReadiness(models: ModelConfig[], fields: AnalysisField[]) {
  const needsVision = fields.some((field) => field.isEnabled && field.imageEnabled);
  const needsText = fields.some((field) => field.isEnabled && field.executionType !== "knowledge_extract");
  const hasVision = models.some((model) => model.purpose === "vision" && model.isPurposeDefault && model.isEnabled);
  const hasText = models.some((model) => model.purpose === "text" && model.isPurposeDefault && model.isEnabled);
  return { needsVision, needsText, ready: (!needsVision || hasVision) && (!needsText || hasText) };
}
