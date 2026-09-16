import { applyLostDealAnalysis } from "./006-lost-deal-analysis";

export function applyLostDealKnowledgeMetadata(db: any) {
  applyLostDealAnalysis(db);
}
