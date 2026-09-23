import type {
  AnalysisField,
  SectionConfigVersion,
  SectionExportColumn,
} from "../../shared/types";

export const RECEPTION_EXPORT_COLUMNS: SectionExportColumn[] = [
  { key: "platform_name", outputColumn: "平台", source: "platform_name", format: "value" },
  { key: "conversation_id", outputColumn: "会话ID", source: "conversation_id", format: "value" },
  { key: "quality_issue_names", outputColumn: "问题", source: "reception_quality", format: "reception_issue_names_csv" },
  { key: "quality_issue_dimensions", outputColumn: "维度", source: "reception_quality", format: "reception_issue_dimensions_csv" },
  { key: "quality_issue_deductions", outputColumn: "扣分", source: "reception_quality", format: "reception_issue_deductions_csv" },
  { key: "quality_total_deduction", outputColumn: "合计扣分", source: "reception_quality", format: "reception_total_deduction" },
  { key: "quality_has_d_level", outputColumn: "是否D级", source: "reception_quality", format: "reception_has_d_level" },
  { key: "quality_chat_quotes", outputColumn: "聊天原文", source: "reception_quality", format: "reception_chat_quotes" },
  { key: "quality_evidence", outputColumn: "证据说明", source: "reception_quality", format: "reception_evidence_explanations" },
  { key: "quality_reasons", outputColumn: "判定理由", source: "reception_quality", format: "reception_reasons" },
  { key: "quality_suggestions", outputColumn: "优化建议", source: "reception_quality", format: "reception_suggestions" },
  { key: "quality_grade", outputColumn: "接待流程质检结果", source: "reception_quality", format: "reception_grade" },
  { key: "quality_review_required", outputColumn: "是否待人工复核", source: "reception_quality", format: "reception_review_required" },
  { key: "quality_start_time", outputColumn: "会话开始时间", source: "reception_quality", format: "reception_start_time" },
  { key: "quality_round_count", outputColumn: "对话轮数", source: "reception_quality", format: "reception_round_count" },
];

export function sectionExportSettings(
  sectionId: string,
  fields: AnalysisField[],
): SectionConfigVersion["exportSettings"] {
  if (sectionId === "reception") {
    return {
      rowMode: "screenshot_records",
      outputColumns: RECEPTION_EXPORT_COLUMNS.map((column) => ({ ...column })),
    };
  }
  return {
    rowMode: "records",
    outputColumns: fields
      .filter((field) => field.exportEnabled)
      .map((field) => ({
        key: field.key,
        outputColumn: field.outputColumn ?? null,
        source: "field_result" as const,
        format: "value" as const,
      })),
  };
}
