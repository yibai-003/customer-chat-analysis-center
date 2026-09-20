export type QuotaTone = "normal" | "warning" | "exhausted" | "unlimited" | "invalid";
export type QuotaKind = "finite" | "unlimited" | "invalid";

export interface QuotaInput {
  quotaUsedTokens: number;
  quotaTotalTokens?: number | null;
  quotaSafetyRatio: number;
  quotaBlocked: boolean;
  quotaExhaustedAt?: string | null;
}

export interface QuotaPresentation {
  kind: QuotaKind;
  tone: QuotaTone;
  used: number;
  total: number | null;
  remaining: number | null;
  percent: number;
  progressValue: number;
  statusText: string;
}

function nonNegativeFinite(value: number) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function formatQuotaTokens(value: number) {
  return new Intl.NumberFormat("zh-CN").format(nonNegativeFinite(value));
}

export function quotaPresentation(input: QuotaInput): QuotaPresentation {
  const used = nonNegativeFinite(input.quotaUsedTokens);
  if (input.quotaTotalTokens == null) {
    return {
      kind: "unlimited",
      tone: "unlimited",
      used,
      total: null,
      remaining: null,
      percent: 0,
      progressValue: 0,
      statusText: "不限额",
    };
  }
  const total = input.quotaTotalTokens;
  if (!Number.isFinite(total) || total <= 0) {
    return {
      kind: "invalid",
      tone: "invalid",
      used,
      total: null,
      remaining: null,
      percent: 0,
      progressValue: 0,
      statusText: "额度数据异常",
    };
  }
  const ratio = Math.min(1, used / total);
  const percent = Math.round(ratio * 100);
  const threshold = Number.isFinite(input.quotaSafetyRatio)
    ? Math.min(1, Math.max(0, input.quotaSafetyRatio))
    : 0.95;
  const tone = used >= total || Boolean(input.quotaExhaustedAt)
    ? "exhausted"
    : input.quotaBlocked || ratio >= threshold
      ? "warning"
      : "normal";
  return {
    kind: "finite",
    tone,
    used,
    total,
    remaining: Math.max(0, total - used),
    percent,
    progressValue: Math.min(used, total),
    statusText: tone === "exhausted"
      ? "额度已耗尽"
      : tone === "warning"
        ? "接近安全阈值"
        : "额度正常",
  };
}
