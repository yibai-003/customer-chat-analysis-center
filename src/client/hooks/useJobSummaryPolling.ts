import { useEffect, useLayoutEffect, useRef } from "react";
import type { Job } from "../../shared/types";
import { api } from "../api";

export function useJobSummaryPolling(
  enabled: boolean,
  activeJobId: string | null,
  updateJobs: (jobs: Job[]) => void,
  updateActiveJob: (job: Job) => void,
  refreshActiveJobRecords: (job: Job) => void | Promise<unknown>,
) {
  const callbacksRef = useRef({
    updateJobs,
    updateActiveJob,
    refreshActiveJobRecords,
  });
  useLayoutEffect(() => {
    callbacksRef.current = {
      updateJobs,
      updateActiveJob,
      refreshActiveJobRecords,
    };
  }, [updateJobs, updateActiveJob, refreshActiveJobRecords]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let inFlight = false;
    let request: AbortController | null = null;
    let activeProgress: string | null = null;
    const poll = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      request = new AbortController();
      try {
        const jobs = await api<Job[]>("/api/jobs", { signal: request.signal });
        if (active) {
          callbacksRef.current.updateJobs(jobs);
          const activeJob = activeJobId
            ? jobs.find((job) => job.id === activeJobId)
            : undefined;
          if (activeJob) {
            callbacksRef.current.updateActiveJob(activeJob);
            const nextProgress = [
              activeJob.status,
              activeJob.completedRecords,
              activeJob.failedRecords,
              activeJob.completedFields,
              activeJob.failedFields,
              activeJob.skippedFields,
              activeJob.needsReviewFields,
              activeJob.needsReviewRecords,
              activeJob.pendingRecords,
              activeJob.processingRecords,
            ].join(":");
            if (nextProgress !== activeProgress) {
              await callbacksRef.current.refreshActiveJobRecords(activeJob);
              if (active) activeProgress = nextProgress;
            }
          }
        }
      } catch {
        // The active task poll surfaces request failures; this background refresh is best effort.
      } finally {
        inFlight = false;
        request = null;
      }
    };
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
      request?.abort();
    };
  }, [activeJobId, enabled]);
}
