import { analyzeRecordFields } from "./field-analysis-service";

export async function analyzeRecord(recordId: string, sectionId: string) {
  await analyzeRecordFields(recordId, sectionId);
  return { status: "completed" as const, recordId, sectionId };
}
