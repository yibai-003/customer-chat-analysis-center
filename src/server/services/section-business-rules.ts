import {
  RECEPTION_COMPLETE_HISTORY_REQUIRED_COLUMNS,
  RECEPTION_ISSUE_RULES,
  RECEPTION_RESULT_COLUMNS,
  type ReceptionIssueRule,
} from "./reception-quality-rules";
import { RECEPTION_V4_RESULT_FIELDS } from "./reception-quality-v4-prompts";

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

export function sectionBusinessRules(sectionId: string, sourceFields: string[] = []): Record<string, unknown> {
  if (sectionId !== "reception") return {};
  const modernTemplate = sourceFields.some((field) => field.includes("(conversation_id)"));
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
      imageColumn: modernTemplate ? "聊天截图 (chat_screenshot)" : "聊天截图",
      resultColumns: modernTemplate ? [...RECEPTION_V4_RESULT_FIELDS] : RECEPTION_RESULT_COLUMNS,
      completeHistoricalResultRequiredColumns: modernTemplate
        ? [
          "会话ID (conversation_id)",
          "对话轮数 (turn_count)",
          "等级 (rating)",
          "合计扣分 (total_deduction)",
          "是否待人工复核 (needs_manual_review)",
        ]
        : RECEPTION_COMPLETE_HISTORY_REQUIRED_COLUMNS,
    },
  };
}

export function receptionBusinessRules(value?: Record<string, unknown>): ReceptionBusinessRules {
  const fallback = sectionBusinessRules("reception") as unknown as ReceptionBusinessRules;
  if (value?.kind !== "reception_quality") return fallback;
  return value as unknown as ReceptionBusinessRules;
}
