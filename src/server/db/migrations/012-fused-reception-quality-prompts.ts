import { applyOptimizedReceptionQualityConfiguration } from "./011-optimized-reception-quality-prompts";

export function applyFusedReceptionQualityPrompts(db: any) {
  applyOptimizedReceptionQualityConfiguration(db);
}
