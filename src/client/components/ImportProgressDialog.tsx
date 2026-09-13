import { useEffect, useRef, useState } from "react";
import type { ImportJob } from "../../shared/types";
import { Modal } from "./Modal";

const terminal = new Set(["completed", "failed", "cancelled"]);

export function ImportProgressDialog({
  importJobId,
  onCompleted,
  onClose,
}: {
  importJobId: string;
  onCompleted: (jobId: string) => void;
  onClose: () => void;
}) {
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState("");
  const reported = useRef(false);
  const completedRef = useRef(onCompleted);
  completedRef.current = onCompleted;

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    reported.current = false;
    setJob(null);
    setError("");
    const load = async () => {
      let finished = false;
      try {
        const response = await fetch(`/api/import-jobs/${importJobId}`, { signal: controller.signal });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.success === false) throw new Error(body.error || "读取导入进度失败");
        if (!active) return;
        const next = body.data as ImportJob;
        setJob(next);
        setError("");
        finished = terminal.has(next.status);
        if (next.status === "completed" && next.jobId && !reported.current) {
          reported.current = true;
          completedRef.current(next.jobId);
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "读取导入进度失败");
      } finally {
        if (active && !finished) timer = setTimeout(() => void load(), 800);
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [importJobId]);

  const processed = job?.processedImages ?? 0;
  const total = job?.totalImages ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : job?.status === "completed" ? 100 : 0;
  const statusText = job?.status === "queued" ? "等待后台处理" : job?.status === "processing" ? "正在提取图片和创建记录" : job?.status === "completed" ? "导入完成" : job?.status === "cancelled" ? "导入已取消" : job?.status === "failed" ? "导入失败" : "准备导入";

  return <Modal title="Excel 导入进度" subtitle="BACKGROUND IMPORT / PROGRESS" close={onClose}>
    <div className="import-progress">
      <div className="import-progress-head"><strong>{job?.filename ?? "正在读取文件"}</strong><span>{statusText}</span></div>
      <div className="import-progress-track"><i style={{ width: `${percent}%` }} /></div>
      <div className="import-progress-stats"><span>图片处理<strong>{processed} / {total || "待统计"}</strong></span><span>记录创建<strong>{job?.processedRecords ?? 0} / {job?.totalRecords || "待统计"}</strong></span><span>失败图片<strong>{job?.failedImages ?? 0}</strong></span></div>
      {error && <div className="import-errors"><strong>进度读取失败</strong><p>{error}</p></div>}
      {job?.errorMessage && <div className="import-errors"><strong>导入失败</strong><p>{job.errorMessage}</p></div>}
      <div className="modal-actions"><button className="button light" onClick={onClose}>{job && terminal.has(job.status) ? "关闭" : "后台运行"}</button></div>
    </div>
  </Modal>;
}
