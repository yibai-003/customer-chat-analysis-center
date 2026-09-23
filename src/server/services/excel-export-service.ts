import path from "node:path";
import ExcelJS from "exceljs";
import { getJob, listRecords, getRecord, listSections } from "../db/repositories";
import { db } from "../db/client";
import { config } from "../config";
import { listFields } from "./field-config-service";
import { aggregateFieldResultsForFields } from "./field-run-service";
import { buildOutputPlan, normalizeExcelHeader } from "./excel-template-service";
import { getJobSectionConfigVersion } from "./section-config-version-service";
import type {
  SectionConfigVersion,
  SectionExportColumn,
  SectionExportValueFormat,
} from "../../shared/types";
import { alignReceptionIssueValues } from "../../shared/reception-quality-results";
import type {
  ReceptionIssue,
  ReceptionQualityAnalysis,
} from "./reception-quality";
import type { ReceptionBusinessRules } from "./section-business-rules";

const EXCEL_CELL_CHARACTER_LIMIT = 32_767;

type ExportCellValue = string | number | boolean;
type ReceptionExportIssue = ReceptionIssue & { priority: number };
type ReceptionExportData = {
  quality: ReceptionQualityAnalysis;
  issues: ReceptionExportIssue[];
  aligned: ReturnType<typeof alignReceptionIssueValues>;
  totalDeduction: number;
  hasDLevelIssue: boolean;
  grade: "A" | "B" | "C" | "D";
};

export function exportColumns(sections: ReturnType<typeof listSections>) {
  return sections.flatMap((section) => listFields(section.id)
    .filter((field) => field.exportEnabled !== false)
    .map((field) => ({
      key: field.key,
      header: `${section.name}_${field.label}`,
    })));
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function exportDataError(
  record: { id: string; sheetName: string; rowNumber: number },
  field: string,
  reason: string,
) {
  return new Error(
    `导出数据不一致：记录 ${record.id}（${record.sheetName} 第 ${record.rowNumber} 行）字段“${field}”${reason}`,
  );
}

function calculateReceptionGrade(
  score: number,
  forceD: boolean,
  rules: ReceptionBusinessRules,
): "A" | "B" | "C" | "D" {
  if (forceD) return rules.forceDGrade;
  let selected: ReceptionBusinessRules["gradeThresholds"][number] | undefined;
  for (const threshold of rules.gradeThresholds) {
    if (score >= threshold.minScore && (!selected || threshold.minScore > selected.minScore)) {
      selected = threshold;
    }
  }
  return selected?.grade ?? "D";
}

function receptionExportData(
  value: unknown,
  record: { id: string; sheetName: string; rowNumber: number },
  rules: ReceptionBusinessRules,
): ReceptionExportData | undefined {
  if (value === undefined || value === null || value === "") return;
  const quality = objectValue(value);
  if (!quality) throw exportDataError(record, "统一质检分析", "不是结构化对象");
  const preSaleIssues = Array.isArray(quality.preSaleIssues) ? quality.preSaleIssues : undefined;
  const afterSaleIssues = Array.isArray(quality.afterSaleIssues) ? quality.afterSaleIssues : undefined;
  if (!preSaleIssues || !afterSaleIssues) {
    throw exportDataError(record, "统一质检分析.问题数组", "缺少售前或售后问题数组");
  }
  const ruleById = new Map(rules.issues.map((rule) => [rule.id, rule]));
  const issues: ReceptionExportIssue[] = [];
  for (const raw of [...preSaleIssues, ...afterSaleIssues]) {
    const issue = objectValue(raw);
    const issueId = typeof issue?.issueId === "string" ? issue.issueId : "";
    const rule = ruleById.get(issueId);
    if (!issue || !rule) {
      throw exportDataError(record, "统一质检分析.问题", `包含版本目录外问题 ID：${issueId || "空"}`);
    }
    const chatQuotes = stringArray(issue.chatQuotes);
    if (!chatQuotes
      || typeof issue.evidenceExplanation !== "string"
      || typeof issue.reason !== "string") {
      throw exportDataError(record, `统一质检分析.${issueId}`, "缺少聊天原文、证据说明或判定理由");
    }
    const exportedIssue = {
      issueId,
      name: rule.name,
      dimension: rule.dimension,
      chatQuotes,
      evidenceIds: stringArray(issue.evidenceIds) ?? [],
      evidenceExplanation: issue.evidenceExplanation,
      reason: issue.reason,
      deduction: rule.deduction,
      forceD: rule.forceD,
      violationCount: rule.violationCount,
      suggestion: rule.suggestion,
      priority: rule.priority,
    };
    const index = issues.findIndex((existing) => existing.priority > exportedIssue.priority);
    if (index < 0) issues.push(exportedIssue);
    else issues.splice(index, 0, exportedIssue);
  }

  const aligned = alignReceptionIssueValues({
    ...quality,
    preSaleIssues: issues.filter((issue) =>
      ruleById.get(issue.issueId)?.scope === "preSale"),
    afterSaleIssues: issues.filter((issue) =>
      ruleById.get(issue.issueId)?.scope === "afterSale"),
  });
  if (typeof quality.reviewRequired !== "boolean") {
    throw exportDataError(record, "统一质检分析.reviewRequired", "必须为布尔值");
  }
  const totalDeduction = issues.reduce((sum, issue) => sum + issue.deduction, 0);
  const hasDLevelIssue = issues.some((issue) => issue.forceD);
  const score = Math.max(0, rules.scoreBase - totalDeduction);
  const grade = issues.length === 0 && !quality.reviewRequired
    ? "A"
    : calculateReceptionGrade(score, hasDLevelIssue, rules);
  return {
    quality: quality as unknown as ReceptionQualityAnalysis,
    issues,
    aligned,
    totalDeduction,
    hasDLevelIssue,
    grade,
  };
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function numbered(values: string[]) {
  return values.map((value, index) => `${index + 1}. ${value}`).join("\n");
}

function formatReceptionValue(
  format: SectionExportValueFormat,
  data: ReceptionExportData | undefined,
): ExportCellValue {
  if (!data) return "";
  const { quality, issues, aligned } = data;
  switch (format) {
    case "reception_issue_names_csv":
      return aligned.labels.join("/");
    case "reception_issue_dimensions_csv":
      return aligned.dimensions.join("/");
    case "reception_issue_deductions_csv":
      return aligned.deductions.join("/");
    case "reception_total_deduction":
      return data.totalDeduction;
    case "reception_has_d_level":
      return aligned.labels.length ? data.hasDLevelIssue ? "是" : "否" : "";
    case "reception_chat_quotes":
      return aligned.chatQuotes.join("/");
    case "reception_evidence_explanations":
      return aligned.evidenceExplanations.join("/");
    case "reception_reasons":
      return aligned.reasons.join("/");
    case "reception_suggestions":
      return numbered(unique(issues.map((issue) => issue.suggestion).filter(Boolean)));
    case "reception_grade":
      return data.grade;
    case "reception_review_required":
      return quality.reviewRequired || aligned.hasMismatch ? "是" : "否";
    case "reception_start_time":
      return typeof quality.conversationStartTime === "string" ? quality.conversationStartTime : "";
    case "reception_round_count":
      return typeof quality.conversationRoundCount === "number" ? quality.conversationRoundCount : 0;
    default:
      throw new Error(`不支持的接待质检导出格式：${format}`);
  }
}

function plainCellValue(value: unknown): ExportCellValue {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function assertCellLength(
  value: ExportCellValue,
  sheetName: string,
  rowNumber: number,
  field: string,
) {
  if (typeof value === "string" && value.length > EXCEL_CELL_CHARACTER_LIMIT) {
    throw new Error(
      `Excel 单元格内容超过 ${EXCEL_CELL_CHARACTER_LIMIT} 字符：${sheetName} 第 ${rowNumber} 行，字段“${field}”`,
    );
  }
}

function resultForRecord(
  detail: NonNullable<ReturnType<typeof getRecord>>,
  version: SectionConfigVersion,
) {
  const run = detail.analysisRuns.find((item) => item.sectionId === version.sectionId);
  const fieldResult = aggregateFieldResultsForFields(detail.id, version.fieldsSnapshot);
  const sectionReview = detail.sectionReviews?.[version.sectionId];
  return {
    ...objectValue(run?.result),
    ...fieldResult,
    ...objectValue(detail.humanResult),
    ...objectValue(sectionReview?.humanResult),
  };
}

function valueForColumn(input: {
  column: SectionExportColumn;
  result: Record<string, unknown>;
  platformName: string | null | undefined;
  conversationId: string | null;
  receptionData?: ReceptionExportData;
}) {
  const source = input.column.source ?? "field_result";
  const format = input.column.format ?? "value";
  if (source === "platform_name") return plainCellValue(input.platformName);
  if (source === "conversation_id") return plainCellValue(input.conversationId);
  if (source === "reception_quality") return formatReceptionValue(format, input.receptionData);
  return plainCellValue(input.result[input.column.key]);
}

export async function exportJob(jobId: string) {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");
  const boundVersion = getJobSectionConfigVersion(jobId);
  if (!boundVersion || !job.sectionId || boundVersion.sectionId !== job.sectionId) {
    throw new Error("任务缺少有效的绑定板块配置版本");
  }
  const sourcePath = (db.prepare(
    "SELECT source_path FROM jobs WHERE id = ?",
  ).get(jobId) as { source_path: string } | undefined)?.source_path;
  if (!sourcePath) throw new Error("原始工作簿不存在");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(sourcePath);
  const allRecords = listRecords(jobId);
  const rules = boundVersion.businessRules as unknown as ReceptionBusinessRules;
  const writes: Array<{
    worksheet: ExcelJS.Worksheet;
    rowNumber: number;
    columnNumber: number;
    field: string;
    value: ExportCellValue;
  }> = [];

  for (const worksheet of workbook.worksheets) {
    const records = allRecords.filter((record) => record.sheetName === worksheet.name);
    if (!records.length) continue;
    const headerRow = worksheet.getRow(1);
    const sourceHeaders = Array.from({ length: headerRow.cellCount }, (_, index) =>
      normalizeExcelHeader(headerRow.getCell(index + 1).value));
    const output = buildOutputPlan(sourceHeaders, boundVersion.exportSettings.outputColumns.map((column) => ({
      key: column.key,
      label: column.outputColumn ?? column.key,
      outputColumn: column.outputColumn ?? undefined,
    })));
    for (const target of output) {
      assertCellLength(target.header, worksheet.name, 1, target.header);
      writes.push({
        worksheet,
        rowNumber: 1,
        columnNumber: target.column,
        field: target.header,
        value: target.header,
      });
    }
    for (const record of records) {
      const detail = getRecord(record.id);
      if (!detail) continue;
      if (boundVersion.exportSettings.rowMode === "screenshot_records" && !detail.imagePath.trim()) continue;
      const result = resultForRecord(detail, boundVersion);
      const receptionData = boundVersion.exportSettings.outputColumns.some(
        (column) => column.source === "reception_quality",
      )
        ? receptionExportData(result["统一质检分析"], record, rules)
        : undefined;
      for (const column of boundVersion.exportSettings.outputColumns) {
        const target = output.find((item) => item.key === column.key)!;
        const value = valueForColumn({
          column,
          result,
          platformName: job.platformName,
          conversationId: record.conversationId,
          receptionData,
        });
        assertCellLength(value, worksheet.name, record.rowNumber, target.header);
        writes.push({
          worksheet,
          rowNumber: record.rowNumber,
          columnNumber: target.column,
          field: target.header,
          value,
        });
      }
    }
  }

  for (const write of writes) {
    const cell = write.worksheet.getRow(write.rowNumber).getCell(write.columnNumber);
    if (cell.value !== write.value) cell.value = write.value;
  }
  const exportDir = path.join(config.dataDir, "exports");
  await (await import("node:fs/promises")).mkdir(exportDir, { recursive: true });
  const output = path.join(exportDir, `${job.id}-客服解析结果.xlsx`);
  await workbook.xlsx.writeFile(output);
  return output;
}
