type ReceptionIssueValue = {
  name?: unknown;
  dimension?: unknown;
  deduction?: unknown;
  chatQuotes?: unknown;
  evidenceExplanation?: unknown;
  reason?: unknown;
};

export interface AlignedReceptionIssueValues {
  labels: string[];
  dimensions: string[];
  deductions: string[];
  chatQuotes: string[];
  evidenceExplanations: string[];
  reasons: string[];
  hasMismatch: boolean;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function valuesWithBlanks(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringsWithBlanks(value: unknown) {
  return valuesWithBlanks(value).map((item) => typeof item === "string" ? item.trim() : "");
}

function escapeDelimiter(value: string) {
  return value.replaceAll("/", "／");
}

function issueValues(value: Record<string, unknown>) {
  return [
    ...valuesWithBlanks(value.preSaleIssues),
    ...valuesWithBlanks(value.afterSaleIssues),
  ].flatMap((item) => {
    const issue = asObject(item) as ReceptionIssueValue | undefined;
    return issue ? [issue] : [];
  });
}

function quotesFor(issue: ReceptionIssueValue | undefined) {
  return Array.isArray(issue?.chatQuotes)
    ? issue.chatQuotes.filter((item): item is string => typeof item === "string")
      .map((item) => item.trim()).filter(Boolean)
    : [];
}

export function alignReceptionIssueValues(value: unknown): AlignedReceptionIssueValues {
  const quality = asObject(value) ?? {};
  const labels = stringsWithBlanks(quality.labels);
  const dimensions = stringsWithBlanks(quality.dimensions);
  const deductions = valuesWithBlanks(quality.deductions)
    .map((item) => typeof item === "number" && Number.isFinite(item) ? String(item) : "");
  const issues = issueValues(quality);
  const matched = new Set<number>();
  let hasMismatch = labels.some((label) => !label)
    || labels.length !== dimensions.length
    || labels.length !== deductions.length
    || labels.length !== issues.length;

  const issueForLabel = labels.map((label) => {
    const index = issues.findIndex((issue, candidateIndex) =>
      !matched.has(candidateIndex) && issue.name === label);
    if (index < 0) {
      hasMismatch = true;
      return undefined;
    }
    matched.add(index);
    return issues[index];
  });

  if (matched.size !== issues.length) hasMismatch = true;
  for (let index = 0; index < labels.length; index++) {
    const issue = issueForLabel[index];
    if (!dimensions[index] || !deductions[index]
      || (issue && (issue.dimension !== dimensions[index]
        || String(issue.deduction) !== deductions[index]))) {
      hasMismatch = true;
    }
    if (!quotesFor(issue).length
      || typeof issue?.evidenceExplanation !== "string"
      || !issue.evidenceExplanation.trim()
      || typeof issue.reason !== "string"
      || !issue.reason.trim()) {
      hasMismatch = true;
    }
  }

  return {
    labels: labels.map(escapeDelimiter),
    dimensions: labels.map((_, index) => escapeDelimiter(dimensions[index] ?? "")),
    deductions: labels.map((_, index) => deductions[index] ?? ""),
    chatQuotes: labels.map((_, index) =>
      quotesFor(issueForLabel[index]).map(escapeDelimiter).join("；")),
    evidenceExplanations: labels.map((_, index) => {
      const explanation = issueForLabel[index]?.evidenceExplanation;
      return escapeDelimiter(typeof explanation === "string" ? explanation.trim() : "");
    }),
    reasons: labels.map((_, index) => {
      const reason = issueForLabel[index]?.reason;
      return escapeDelimiter(typeof reason === "string" ? reason.trim() : "");
    }),
    hasMismatch,
  };
}
