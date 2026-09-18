import type { JobStatus, RecordStatus } from "../shared/types";
export function analysisStatusMessage(status: JobStatus | RecordStatus | undefined, needsReview = 0) {
  if (status === "failed") return "解析存在失败，请查看失败原因并重试";
  if (status === "needs_review" || (status === "completed" && needsReview > 0)) return "处理已结束，仍有记录需要复核";
  if (status === "paused") return "解析已暂停，仍有记录待处理，可继续解析";
  if (status === "cancelled") return "解析已取消，已有结果已保留";
  if (status === "completed") return "解析完成";
  return "状态已更新，请检查当前记录";
}
