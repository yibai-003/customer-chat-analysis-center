import type { ReceptionImportContract } from "./section-business-rules";

export interface ReceptionResultInspection {
  status: "empty" | "complete" | "conflict";
  filledFields: string[];
  missingFields: string[];
  extraFields: string[];
}

export interface ReceptionImportConflict extends ReceptionResultInspection {
  sheetName: string;
  rowNumber: number;
}

function hasValue(value: unknown) {
  return String(value ?? "").trim().length > 0;
}

export function inspectReceptionResultRow(
  sourceFields: Record<string, string>,
  contract: ReceptionImportContract,
): ReceptionResultInspection {
  const filledFields = contract.resultColumns
    .filter((field) => hasValue(sourceFields[field]));
  if (!filledFields.length) {
    return { status: "empty", filledFields: [], missingFields: [], extraFields: [] };
  }

  const missingFields = contract.completeHistoricalResultRequiredColumns
    .filter((field) => !hasValue(sourceFields[field]));
  if (!missingFields.length) {
    return { status: "complete", filledFields, missingFields: [], extraFields: [] };
  }

  const required = new Set(contract.completeHistoricalResultRequiredColumns);
  return {
    status: "conflict",
    filledFields,
    missingFields,
    extraFields: filledFields.filter((field) => !required.has(field)),
  };
}

export function receptionImportConflictMessage(conflicts: ReceptionImportConflict[]) {
  return `接待质检结果区存在冲突：${conflicts.map((conflict) => {
    const details = [
      "原因：结果区部分填写或字段组合不合法",
      conflict.filledFields.length ? `已填写字段：${conflict.filledFields.join("、")}` : "",
      conflict.missingFields.length ? `缺失字段：${conflict.missingFields.join("、")}` : "",
      conflict.extraFields.length ? `多余字段：${conflict.extraFields.join("、")}` : "",
    ].filter(Boolean).join("；");
    return `${conflict.sheetName} 第 ${conflict.rowNumber} 行（${details}）`;
  }).join("；")}`;
}
