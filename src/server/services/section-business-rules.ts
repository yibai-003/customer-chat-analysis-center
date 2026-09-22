import { RECEPTION_ISSUE_RULES } from "./reception-quality-rules";

export function sectionBusinessRules(sectionId: string): Record<string, unknown> {
  if (sectionId !== "reception") return {};
  return {
    kind: "reception_quality",
    scoreBase: 100,
    gradeThresholds: [
      { grade: "A", minScore: 95 },
      { grade: "B", minScore: 90 },
      { grade: "C", minScore: 80 },
      { grade: "D", minScore: 0 },
    ],
    forceDGrade: "D",
    issues: RECEPTION_ISSUE_RULES,
  };
}
