export interface StructuredListItem {
  name: string;
  evidence: string;
  confidence: number;
}

export interface StructuredResultSection {
  label: string;
  items: (parsed: Record<string, unknown>) => StructuredListItem[];
}

export interface StructuredResultViewConfig {
  className: string;
  ariaLabel: string;
  title: string;
  sections: StructuredResultSection[];
  detail: {
    label: string;
    fallback: string;
    value: (parsed: Record<string, unknown>) => string;
  };
  evidence: (parsed: Record<string, unknown>) => string[];
  evidenceFallback: string;
  confidence: (parsed: Record<string, unknown>) => number;
  confidenceFallback: string;
  reviewRequired: (parsed: Record<string, unknown>) => boolean;
  statusLabels: { review: string; ok: string };
  warning: string;
  listFallback: string;
}

export function structuredItems(value: unknown): StructuredListItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { name: string; evidence: string; confidence: number } => (
    Boolean(item)
    && typeof item === "object"
    && typeof (item as Record<string, unknown>).name === "string"
  )).map((item) => ({
    name: typeof (item as Record<string, unknown>).proposedName === "string"
      ? `${item.name}（建议：${(item as Record<string, unknown>).proposedName}）`
      : item.name,
    evidence: typeof item.evidence === "string" ? item.evidence : "",
    confidence: typeof item.confidence === "number" ? item.confidence : Number(item.confidence) || 0,
  }));
}

export function StructuredResultView({ config, value }: {
  config: StructuredResultViewConfig;
  value: unknown;
}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = value as Record<string, unknown>;
  const reviewRequired = config.reviewRequired(parsed);
  const confidence = config.confidence(parsed);
  const evidence = config.evidence(parsed);
  const list = (items: StructuredListItem[]) => items.length
    ? items.map((item) => `${item.name}${item.evidence ? ` · ${item.evidence}` : ""}`).join("\n")
    : config.listFallback;

  return <div className={config.className} aria-label={config.ariaLabel}>
    <div className={`${config.className}-head`}>
      <h4>{config.title}</h4>
      <span className={reviewRequired ? "review-flag" : "confidence-flag"}>
        {reviewRequired ? config.statusLabels.review : config.statusLabels.ok}
      </span>
    </div>
    <div className={`${config.className}-grid`}>
      {config.sections.map((section) => <div key={section.label}>
        <small>{section.label}</small>
        <strong>{list(section.items(parsed))}</strong>
      </div>)}
      <div>
        <small>{config.detail.label}</small>
        <strong>{config.detail.value(parsed) || config.detail.fallback}</strong>
      </div>
    </div>
    <div className={`${config.className}-meta`}>
      <div><small>整体证据</small><span>{evidence.length ? evidence.join("\n") : config.evidenceFallback}</span></div>
      <div><small>整体置信度</small><b>{Number.isFinite(confidence) ? `${Math.round(confidence * 100)}%` : config.confidenceFallback}</b></div>
    </div>
    {reviewRequired && <p className={`${config.className}-warning`}>{config.warning}</p>}
  </div>;
}
