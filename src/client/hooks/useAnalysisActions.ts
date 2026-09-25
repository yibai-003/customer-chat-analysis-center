import { useRef, useState } from "react";
import type { AnalysisCapacity, AnalysisJobOptions, AnalysisSection, Job } from "../../shared/types";
import { api } from "../api";
import { analysisStatusMessage } from "../analysis-status";
import type { useAnalysisPolling } from "./useAnalysisPolling";
import type { useRecordWorkspace } from "./useRecordWorkspace";
import type { JobOperationHelpers } from "./workspace-types";

type AnalysisRunOptions = Required<Pick<AnalysisJobOptions, "concurrency" | "batchSize" | "maxPaidTokens">>;
type TargetedSummary = { selected: number; executable: number; skipped: number };
const targetedNotice = (summary: TargetedSummary) =>
  `已选择 ${summary.selected} 条：可执行 ${summary.executable} 条，跳过 ${summary.skipped} 条`;

type PollControls = Pick<
  ReturnType<typeof useAnalysisPolling>,
  "startAnalysisPoll" | "cancelAnalysisPoll" | "suspendAnalysisPoll" | "resumeAnalysisPoll"
>;

export function useAnalysisActions(deps: {
  job: Job | null;
  currentSection?: AnalysisSection;
  selected: ReturnType<typeof useRecordWorkspace>["selected"];
  modelReadiness: { ready: boolean };
  canManageConfig: boolean;
  mountedRef: { current: boolean };
  taskActionBusy: boolean;
  setNotice: (message: string) => void;
  setDialog: (value: "model" | "section" | null) => void;
  setAnalysisCapacity: (value: AnalysisCapacity | null) => void;
  refresh: (jobId?: string, options?: { page?: number; pageSize?: number; filter?: string }) => Promise<boolean>;
  refreshCurrentRecordPage: (jobId: string, current: () => boolean) => Promise<boolean>;
  commitJobSummary: (job: Job) => void;
  operations: JobOperationHelpers;
  poll: PollControls;
}) {
  const {
    job,
    currentSection,
    selected,
    modelReadiness,
    canManageConfig,
    mountedRef,
    taskActionBusy,
    setNotice,
    setDialog,
    setAnalysisCapacity,
    refresh,
    refreshCurrentRecordPage,
    commitJobSummary,
    operations,
    poll,
  } = deps;
  const { captureJobOperation, isJobOperationCurrent, startBusyOperation, finishBusyOperation, startTaskActionOperation, finishTaskActionOperation } = operations;
  const { startAnalysisPoll, cancelAnalysisPoll, suspendAnalysisPoll, resumeAnalysisPoll } = poll;
  const pendingRecordIdsRef = useRef<string[] | null>(null);
  const [pendingTargetedCount, setPendingTargetedCount] = useState<number | null>(null);
  const [targetedSummary, setTargetedSummary] = useState<{
    selected: number;
    executable: number;
    skipped: number;
  } | null>(null);

  const analyzeRecord = async (recordId: string) => {
    if (!job || !currentSection) return;
    const operation = captureJobOperation();
    const operationJobId = job.id;
    startBusyOperation(operation); setNotice("");
    try {
      const outcome = await api<{ status?: import("../../shared/types").RecordStatus }>(`/api/records/${recordId}/analyze`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionId: currentSection.id }),
      });
      if (!isJobOperationCurrent(operation)) return;
      const refreshed = await refresh(operationJobId);
      if (refreshed && isJobOperationCurrent(operation)) {
        setNotice(analysisStatusMessage(outcome.status));
      }
    } catch (error) {
      if (isJobOperationCurrent(operation)) {
        setNotice(error instanceof Error ? error.message : "解析失败");
      }
    } finally { finishBusyOperation(operation); }
  };

  const requestBatchAnalysis = async (recordIds?: string[]) => {
    if (!job || !currentSection) return;
    pendingRecordIdsRef.current = recordIds && recordIds.length ? [...recordIds] : null;
    setPendingTargetedCount(pendingRecordIdsRef.current?.length ?? null);
    if (!modelReadiness.ready) {
      setNotice(canManageConfig
        ? "请先在模型配置中验证并启用对应的视觉模型和文本模型"
        : "模型尚未就绪，请联系配置人员验证并启用对应的视觉模型和文本模型");
      if (canManageConfig) setDialog("model");
      return;
    }
    const operation = captureJobOperation();
    startBusyOperation(operation); setNotice("");
    try {
      const capacity = await api<AnalysisCapacity>("/api/system/analysis-capacity");
      if (!isJobOperationCurrent(operation)) return;
      setAnalysisCapacity(capacity);
    } catch (error) {
      if (isJobOperationCurrent(operation)) {
        setNotice(error instanceof Error ? error.message : "系统容量指标暂时不可用");
      }
    } finally {
      finishBusyOperation(operation);
    }
  };

  const startBatchAnalysis = async (options: AnalysisRunOptions) => {
    if (!job || !currentSection) return;
    setAnalysisCapacity(null);
    const operation = captureJobOperation();
    const operationJobId = job.id;
    const sectionId = currentSection.id;
    const recordIds = pendingRecordIdsRef.current;
    pendingRecordIdsRef.current = null;
    setPendingTargetedCount(null);
    startBusyOperation(operation); setNotice("");
    try {
      const current = await api<Job & { targeted?: TargetedSummary }>(`/api/jobs/${operationJobId}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionId, ...options, ...(recordIds ? { recordIds } : {}) }),
      });
      if (!isJobOperationCurrent(operation)) return;
      const targeted = current.targeted;
      if (targeted) setTargetedSummary(targeted);
      commitJobSummary(current);
      finishBusyOperation(operation);
      if (current.status === "processing") {
        if (targeted) setNotice(targetedNotice(targeted));
        startAnalysisPoll(current);
      } else {
        await refreshCurrentRecordPage(
          operationJobId,
          () => mountedRef.current && isJobOperationCurrent(operation),
        );
        if (mountedRef.current && isJobOperationCurrent(operation)) {
          setNotice(targeted
            ? `${targetedNotice(targeted)}；解析完成，请检查需复核记录`
            : "解析完成，请检查需复核记录");
        }
      }
    } catch (error) {
      if (isJobOperationCurrent(operation)) {
        setNotice(error instanceof Error ? error.message : "解析失败");
      }
    } finally {
      finishBusyOperation(operation);
    }
  };

  const retryField = async (fieldKey: string) => {
    if (!selected || !currentSection || !job) return;
    const operation = captureJobOperation();
    const operationJobId = job.id;
    const recordId = selected.id;
    startBusyOperation(operation); setNotice("");
    try {
      await api(`/api/records/${recordId}/retry-field`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionId: currentSection.id, fieldKey }),
      });
      if (!isJobOperationCurrent(operation)) return;
      const refreshed = await refresh(operationJobId);
      if (refreshed && isJobOperationCurrent(operation)) setNotice(`${fieldKey} 已重新解析`);
    } catch (error) {
      if (isJobOperationCurrent(operation)) {
        setNotice(error instanceof Error ? error.message : "字段重试失败");
      }
    } finally { finishBusyOperation(operation); }
  };

  const taskAction = async (action: "pause" | "cancel" | "retry-failed") => {
    if (!job || taskActionBusy) return;
    const operation = captureJobOperation();
    const operationJobId = job.id;
    const pollSuspension = action === "retry-failed"
      ? null
      : suspendAnalysisPoll(operationJobId);
    let actionAccepted = false;
    startTaskActionOperation(operation); setNotice("");
    try {
      await api(`/api/jobs/${operationJobId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      actionAccepted = true;
      if (action !== "retry-failed") cancelAnalysisPoll(operationJobId);
      if (!isJobOperationCurrent(operation)) return;
      const refreshed = await refresh(operationJobId);
      if (refreshed && isJobOperationCurrent(operation)) {
        setNotice(action === "pause" ? "解析任务已暂停" : action === "cancel" ? "解析任务已取消" : "已开始重试失败记录");
      }
    } catch (error) {
      if (isJobOperationCurrent(operation)) {
        setNotice(error instanceof Error ? error.message : "任务操作失败");
      }
    } finally {
      if (!actionAccepted) resumeAnalysisPoll(pollSuspension);
      finishTaskActionOperation(operation);
    }
  };

  return {
    analyzeRecord,
    requestBatchAnalysis,
    startBatchAnalysis,
    retryField,
    taskAction,
    pendingTargetedCount,
    targetedSummary,
  };
}
