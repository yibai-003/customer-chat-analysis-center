import {
  RECEPTION_COMPLETE_HISTORY_REQUIRED_COLUMNS,
  RECEPTION_ISSUE_RULES,
  RECEPTION_RESULT_COLUMNS,
  type ReceptionIssueRule,
} from "./reception-quality-rules";

export interface ReceptionImportContract {
  imageColumn: string;
  resultColumns: string[];
  completeHistoricalResultRequiredColumns: string[];
}

export interface ReceptionBusinessRules {
  kind: "reception_quality";
  scoreBase: number;
  gradeThresholds: Array<{ grade: "A" | "B" | "C" | "D"; minScore: number }>;
  forceDGrade: "D";
  issues: ReceptionIssueRule[];
  importContract: ReceptionImportContract;
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
    importContract: {
      imageColumn: "聊天截图",
      resultColumns: RECEPTION_RESULT_COLUMNS,
      completeHistoricalResultRequiredColumns: RECEPTION_COMPLETE_HISTORY_REQUIRED_COLUMNS,
    },
  };
}

export function receptionBusinessRules(value?: Record<string, unknown>): ReceptionBusinessRules {
  const fallback = sectionBusinessRules("reception") as unknown as ReceptionBusinessRules;
  if (value?.kind !== "reception_quality") return fallback;
  return value as unknown as ReceptionBusinessRules;
}
