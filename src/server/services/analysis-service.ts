import { analyzeRecordFields } from "./field-analysis-service";

export async function analyzeRecord(recordId: string, sectionId: string) {
  const fields = await analyzeRecordFields(recordId, sectionId);
  const status = fields.failed > 0 ? "failed" : fields.needsReview > 0 || fields.skipped > 0 ? "needs_review" : "completed";
  return { status, recordId, sectionId, fields };
}
