import { RECEPTION_ISSUE_RULES, type ReceptionIssueRule } from "./reception-quality-rules";

export interface ReceptionBusinessRules {
  kind: "reception_quality";
  scoreBase: number;
  gradeThresholds: Array<{ grade: "A" | "B" | "C" | "D"; minScore: number }>;
  forceDGrade: "D";
  issues: ReceptionIssueRule[];
}

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

export function receptionBusinessRules(value?: Record<string, unknown>): ReceptionBusinessRules {
  const fallback = sectionBusinessRules("reception") as unknown as ReceptionBusinessRules;
  if (value?.kind !== "reception_quality") return fallback;
  return value as unknown as ReceptionBusinessRules;
}
