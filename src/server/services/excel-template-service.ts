export function normalizeExcelHeader(value: unknown) {
  return String(value ?? "").trim();
}

export function excelHeaderParts(value: unknown) {
  const raw = normalizeExcelHeader(value);
  const matched = raw.match(/^(.*?)\s*[（(]\s*([A-Za-z][A-Za-z0-9_]*)\s*[)）]\s*$/);
  return {
    raw,
    label: matched?.[1]?.trim() || raw,
    key: matched?.[2]?.trim() || "",
  };
}

const fieldHeaderKeys: Record<string, string[]> = {
  platform_name: ["platform_name"],
  conversation_id: ["conversation_id"],
  quality_issue_names: ["issue"],
  quality_issue_dimensions: ["dimension"],
  quality_issue_deductions: ["deduction"],
  quality_total_deduction: ["total_deduction"],
  quality_has_d_level: ["d_level"],
  quality_chat_quotes: ["chat_excerpt"],
  quality_evidence: ["evidence"],
  quality_reasons: ["judgement_reason"],
  quality_suggestions: ["improvement_advice"],
  quality_grade: ["rating"],
  quality_review_required: ["needs_manual_review"],
  quality_start_time: ["conversation_started_at"],
  quality_round_count: ["turn_count"],
};

export function excelHeaderMatches(
  actual: unknown,
  expected: string,
  fieldKey?: string,
) {
  const parts = excelHeaderParts(actual);
  const expectedParts = excelHeaderParts(expected);
  if (!parts.raw || !expectedParts.raw) return false;
  if (parts.raw === expectedParts.raw
    || parts.label === expectedParts.label
    || (parts.key && parts.key === expectedParts.key)
    || parts.key === expectedParts.raw) {
    return true;
  }
  return fieldKey
    ? (fieldHeaderKeys[fieldKey] ?? []).includes(parts.key)
    : false;
}

export function mergeTemplateHeaders(existing: string[], imported: string[]) {
  return [...new Set([...existing, ...imported].map(normalizeExcelHeader).filter(Boolean))];
}

export function buildOutputPlan(
  headers: string[],
  fields: Array<{ key: string; label: string; outputColumn?: string; exportEnabled?: boolean }>,
) {
  const normalizedHeaders = headers.map(normalizeExcelHeader);
  const used = new Set(normalizedHeaders.filter(Boolean));
  let nextColumn = headers.length + 1;
  return fields.filter((field) => field.exportEnabled !== false).map((field) => {
    const header = normalizeExcelHeader(field.outputColumn || field.label || field.key);
    const existing = normalizedHeaders.findIndex((item) => excelHeaderMatches(item, header, field.key));
    if (existing >= 0) return {
      key: field.key,
      column: existing + 1,
      header: normalizedHeaders[existing],
    };
    while (used.has(header)) nextColumn++;
    used.add(header);
    return { key: field.key, column: nextColumn++, header };
  });
}
