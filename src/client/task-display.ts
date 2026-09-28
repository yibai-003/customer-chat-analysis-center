import type { Job, JobStatus } from "../shared/types";

export const taskStatusLabels: Record<JobStatus, string> = {
  ready: "导入完成，待解析",
  processing: "解析中",
  paused: "已暂停",
  completed: "解析已完成",
  failed: "解析失败",
  cancelled: "已取消",
};

export function taskStatusMessage(status: JobStatus) {
  return taskStatusLabels[status];
}

export function pendingRecordCount(job: Job) {
  if (typeof job.pendingRecords === "number") return Math.max(0, job.pendingRecords);
  return Math.max(
    0,
    job.totalRecords
      - job.completedRecords
      - job.failedRecords
      - (job.needsReviewRecords ?? 0)
      - (job.processingRecords ?? 0),
  );
}

export function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(value >= 100_000 ? 0 : 1))}K`;
  return String(value);
}
