export function normalizeExcelHeader(value: unknown) {
  return String(value ?? "").trim();
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
    const existing = normalizedHeaders.findIndex((item) => item === header);
    if (existing >= 0) return { key: field.key, column: existing + 1, header };
    while (used.has(header)) nextColumn++;
    used.add(header);
    return { key: field.key, column: nextColumn++, header };
  });
}
