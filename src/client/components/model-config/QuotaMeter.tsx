import { formatQuotaTokens, type QuotaPresentation } from "./quota-presentation";

export function QuotaMeter({
  modelName,
  quota,
}: {
  modelName: string;
  quota: QuotaPresentation;
}) {
  if (quota.kind !== "finite" || quota.total == null) {
    return (
      <div className={`quota-meter ${quota.tone}`} data-quota-state={quota.tone}>
        <span className="quota-meter-value">{formatQuotaTokens(quota.used)}</span>
        <span className="quota-meter-status">{quota.statusText}</span>
      </div>
    );
  }

  return (
    <div className={`quota-meter ${quota.tone}`} data-quota-state={quota.tone}>
      <span className="quota-meter-value">
        {formatQuotaTokens(quota.used)} / {formatQuotaTokens(quota.total)}
      </span>
      <span
        className="quota-meter-track"
        role="progressbar"
        aria-label={`${modelName}额度 ${quota.percent}%`}
        aria-valuemin={0}
        aria-valuemax={quota.total}
        aria-valuenow={quota.progressValue}
      >
        <span className="quota-meter-fill" style={{ width: `${quota.percent}%` }} />
      </span>
      <span className="quota-meter-status">{quota.statusText}</span>
    </div>
  );
}
