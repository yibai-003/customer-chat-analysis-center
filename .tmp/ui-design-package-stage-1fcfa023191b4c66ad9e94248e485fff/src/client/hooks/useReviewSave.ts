import type { AnalysisSection, Job } from "../../shared/types";
import { useRef } from "react";
import type { JobOperationToken } from "./workspace-types";
import type { useRecordWorkspace } from "./useRecordWorkspace";
import type { useAnalysisPolling } from "./useAnalysisPolling";
import { api } from "../api";
import type { RecordDetail } from "../../shared/types";
interface ReviewOptions { records: ReturnType<typeof useRecordWorkspace>; job: Job | null; busy: boolean; currentSection?: AnalysisSection; captureJobOperation: () => JobOperationToken; isJobOperationCurrent: (token: JobOperationToken) => boolean; startBusyOperation: (token: JobOperationToken) => void; finishBusyOperation: (token: JobOperationToken) => void; setNotice: (message: string) => void; refresh: (jobId?: string) => Promise<boolean>; suspendAnalysisPoll: ReturnType<typeof useAnalysisPolling>["suspendAnalysisPoll"]; resumeAnalysisPoll: ReturnType<typeof useAnalysisPolling>["resumeAnalysisPoll"] }
export function useReviewSave(options: ReviewOptions) {
  const savingRef = useRef(false);
  const {
    records,
    job,
    busy,
    currentSection,
    captureJobOperation,
    isJobOperationCurrent,
    startBusyOperation,
    finishBusyOperation,
    setNotice,
    refresh,
    suspendAnalysisPoll,
    resumeAnalysisPoll,
  } = options;
  const { selected, detailRevisionRef, selectedRef, detailRequestIdRef, detailDirtyRef, setSelectedRecord, recordPageRef, setRecordPage } = records;
  const saveReview = async () => {
    if (!selected || !job || busy || savingRef.current) return;
    savingRef.current = true;
    const operation = captureJobOperation();
    const operationJobId = job.id;
    const recordId = selected.id;
    const detailRevision = detailRevisionRef.current;
    const sectionReview = currentSection ? selected.sectionReviews?.[currentSection.id] : undefined;
    const suspension = suspendAnalysisPoll(operationJobId);
    startBusyOperation(operation);
    setNotice("");
    try {
    const savedRecord = await api<RecordDetail>(`/api/records/${selected.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sectionId: currentSection?.id, humanResult: sectionReview?.humanResult ?? selected.humanResult, reviewStatus: "confirmed", reviewNote: sectionReview?.reviewNote ?? selected.reviewNote, status: "completed" }),
    });
    if (
      !isJobOperationCurrent(operation)
      || detailRevisionRef.current !== detailRevision
      || selectedRef.current?.id !== recordId
    ) return;
    detailRequestIdRef.current += 1;
    detailRevisionRef.current += 1;
    detailDirtyRef.current = false;
    setSelectedRecord(savedRecord);
    const nextPage = { ...recordPageRef.current, items: recordPageRef.current.items.map((item) => item.id === recordId ? { ...item, status: savedRecord.status, reviewStatus: savedRecord.reviewStatus } : item) };
    recordPageRef.current = nextPage;
    setRecordPage(nextPage);
    const refreshed = await refresh(operationJobId);
    if (refreshed && isJobOperationCurrent(operation)) setNotice("复核结果已保存");
    } catch (error) {
      if (isJobOperationCurrent(operation)) setNotice(error instanceof Error ? error.message : "保存复核失败，请重试");
    } finally {
      savingRef.current = false;
      resumeAnalysisPoll(suspension);
      finishBusyOperation(operation);
    }
  };
  return saveReview;
}
