import { useEffect, useRef, type RefObject } from "react";
import type { Job } from "../../shared/types";
import { api } from "../api";
import { analysisStatusMessage } from "../analysis-status";

interface AnalysisPollController {
  id: number;
  jobId: string;
  generation: number;
  previousProgress: string;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  suspended: boolean;
  cancelled: boolean;
  running: boolean;
  request: AbortController | null;
}

interface AnalysisPollSuspension {
  controller: AnalysisPollController;
  generation: number;
}

function analysisProgressKey(job: Job) {
  return [
    job.totalRecords,
    job.completedRecords,
    job.failedRecords,
    job.totalFields,
    job.completedFields,
    job.failedFields,
    job.skippedFields,
    job.needsReviewFields,
    job.needsReviewRecords,
    job.pendingRecords,
    job.processingRecords,
  ].join(":");
}

interface PollOptions { mountedRef: RefObject<boolean>; activeJobIdRef: RefObject<string | null>; jobRef: RefObject<Job | null>; commitJobSummary: (job: Job) => void; refreshCurrentRecordPage: (jobId: string, current: () => boolean) => Promise<boolean>; setNotice: (message: string) => void }
export function useAnalysisPolling(options: PollOptions) {
  const latest = useRef(options); latest.current = options;
  const { mountedRef, activeJobIdRef, jobRef, setNotice } = options;
  const analysisPollIdRef = useRef(0);
  const analysisPollRef = useRef<AnalysisPollController | null>(null);
  const clearAnalysisPollTimeout = (controller: AnalysisPollController) => {
    if (controller.timeoutHandle === null) return;
    clearTimeout(controller.timeoutHandle);
    controller.timeoutHandle = null;
  };

  const cancelAnalysisPoll = (jobId?: string) => {
    const controller = analysisPollRef.current;
    if (!controller || (jobId && controller.jobId !== jobId)) return;
    controller.cancelled = true;
    controller.suspended = false;
    controller.generation += 1;
    clearAnalysisPollTimeout(controller);
    controller.request?.abort();
    analysisPollRef.current = null;
  };

  const suspendAnalysisPoll = (jobId: string): AnalysisPollSuspension | null => {
    const controller = analysisPollRef.current;
    if (!controller || controller.jobId !== jobId || controller.cancelled) return null;
    clearAnalysisPollTimeout(controller);
    controller.suspended = true;
    controller.generation += 1;
    controller.request?.abort();
    return { controller, generation: controller.generation };
  };

  const isAnalysisPollCurrent = (
    controller: AnalysisPollController,
    generation: number,
  ) => (
    mountedRef.current
    && analysisPollRef.current === controller
    && !controller.cancelled
    && !controller.suspended
    && controller.generation === generation
    && activeJobIdRef.current === controller.jobId
  );

  const scheduleAnalysisPoll = (controller: AnalysisPollController) => {
    if (
      !mountedRef.current
      || analysisPollRef.current !== controller
      || controller.cancelled
      || controller.suspended
      || controller.running
      || controller.timeoutHandle !== null
    ) return;
    const generation = controller.generation;
    controller.timeoutHandle = setTimeout(() => {
      controller.timeoutHandle = null;
      void pollAnalysisJob(controller, generation);
    }, 2000);
  };

  const resumeAnalysisPoll = (suspension: AnalysisPollSuspension | null) => {
    if (!suspension) return;
    const { controller, generation } = suspension;
    if (
      !mountedRef.current
      || analysisPollRef.current !== controller
      || controller.cancelled
      || !controller.suspended
      || controller.generation !== generation
      || activeJobIdRef.current !== controller.jobId
      || jobRef.current?.id !== controller.jobId
      || jobRef.current.status !== "processing"
    ) return;
    controller.suspended = false;
    scheduleAnalysisPoll(controller);
  };

  async function pollAnalysisJob(
    controller: AnalysisPollController,
    generation: number,
  ) {
    if (!isAnalysisPollCurrent(controller, generation)) return;
    controller.running = true;
    const request = new AbortController(); controller.request = request;
    try {
      const current = await api<Job>(`/api/jobs/${controller.jobId}`, { signal: request.signal });
      if (!isAnalysisPollCurrent(controller, generation)) return;
      latest.current.commitJobSummary(current);
      const nextProgress = analysisProgressKey(current);
      const terminal = current.status !== "processing";
      if (terminal || nextProgress !== controller.previousProgress) {
        await latest.current.refreshCurrentRecordPage(
          controller.jobId,
          () => isAnalysisPollCurrent(controller, generation),
        );
        if (!isAnalysisPollCurrent(controller, generation)) return;
      }
      controller.previousProgress = nextProgress;
      if (terminal) {
        cancelAnalysisPoll(controller.jobId);
        if (mountedRef.current) setNotice(analysisStatusMessage(current.status, current.needsReviewRecords));
        return;
      }
      scheduleAnalysisPoll(controller);
    } catch (error) {
      if (!isAnalysisPollCurrent(controller, generation)) return;
      setNotice(error instanceof Error ? error.message : "解析状态刷新失败");
      scheduleAnalysisPoll(controller);
    } finally {
      controller.running = false;
      if (controller.request === request) controller.request = null;
      scheduleAnalysisPoll(controller);
    }
  }

  const startAnalysisPoll = (current: Job) => {
    cancelAnalysisPoll();
    if (
      !mountedRef.current
      || current.status !== "processing"
      || activeJobIdRef.current !== current.id
    ) return;
    const controller: AnalysisPollController = {
      id: ++analysisPollIdRef.current,
      jobId: current.id,
      generation: 1,
      previousProgress: analysisProgressKey(current),
      timeoutHandle: null,
      suspended: false,
      cancelled: false,
      running: false,
      request: null,
    };
    analysisPollRef.current = controller;
    scheduleAnalysisPoll(controller);
  };

  useEffect(() => () => cancelAnalysisPoll(), []);
  return { cancelAnalysisPoll, suspendAnalysisPoll, resumeAnalysisPoll, startAnalysisPoll };
}
