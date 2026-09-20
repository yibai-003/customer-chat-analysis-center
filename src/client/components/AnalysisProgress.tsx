import type { Job } from "../../shared/types";

function percentage(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}

function ProgressMetric({
  label,
  value,
  total,
}: {
  label: string;
  value: number;
  total: number;
}) {
  const percent = percentage(value, total);
  return (
    <div className="analysis-progress-metric">
      <div className="analysis-progress-heading">
        <span>{label}</span>
        <strong>{value} / {total}</strong>
        <b>{percent}%</b>
      </div>
      <div
        className="analysis-progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={total}
      >
        <i style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function AnalysisProgress({ job }: { job: Job }) {
  const processedRecords = Math.min(
    job.totalRecords,
    Math.max(0, job.completedRecords + job.failedRecords + (job.needsReviewRecords ?? 0)),
  );

  if (job.status === "completed") {
    return (
      <section className="analysis-progress analysis-progress-compact" aria-label="已完成任务摘要">
        <strong className="analysis-progress-complete-label">任务已完成</strong>
        <div className="analysis-progress-compact-stats">
          <span><strong>{job.totalRecords}</strong> 条记录</span>
          <span>成功 <strong>{job.completedRecords}</strong></span>
          <span>待复核 <strong>{job.needsReviewRecords ?? 0}</strong></span>
          <span>失败 <strong>{job.failedRecords}</strong></span>
        </div>
      </section>
    );
  }

  return (
    <section className="analysis-progress" aria-label="当前任务解析进度">
      <ProgressMetric label="记录进度" value={processedRecords} total={job.totalRecords} />
      <ProgressMetric label="字段进度" value={Math.min(job.totalFields, job.completedFields + job.failedFields + job.skippedFields + (job.needsReviewFields ?? 0))} total={job.totalFields} />
      <div className="analysis-progress-stats">
        <span>成功 <strong>{job.completedRecords}</strong></span>
        <span>待复核 <strong>{job.needsReviewRecords ?? 0}</strong></span>
        <span>字段待复核 <strong>{job.needsReviewFields ?? 0}</strong></span>
        <span>失败 <strong>{job.failedRecords}</strong></span>
        <span>字段失败 <strong>{job.failedFields}</strong></span>
        <span>跳过 <strong>{job.skippedFields}</strong></span>
      </div>
    </section>
  );
}
