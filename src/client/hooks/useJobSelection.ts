import { useEffect, useRef, useState } from "react";
import type { AnalysisSection, Job, ModelConfig, Platform } from "../../shared/types";
import { api } from "../api";
import { useAnalysisPolling } from "./useAnalysisPolling";
import { EMPTY_RECORD_PAGE, EMPTY_RECORD_QUERY, type RecordQueryIdentity, type useRecordWorkspace } from "./useRecordWorkspace";
import type { JobOperationHelpers, JobOperationToken } from "./workspace-types";

interface NavigationToken {
  navigationId: number;
  jobId: string;
}

type RecordWorkspace = ReturnType<typeof useRecordWorkspace>;

export function useJobSelection({ setNotice, records }: {
  setNotice: (message: string) => void;
  records: RecordWorkspace;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [sections, setSections] = useState<AnalysisSection[]>([]);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [busy, setBusy] = useState(false);
  const [taskActionBusy, setTaskActionBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshPendingRef = useRef(false);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const activeJobGenerationRef = useRef(0);
  const operationIdRef = useRef(0);
  const busyOperationIdRef = useRef<number | null>(null);
  const taskActionOperationIdRef = useRef<number | null>(null);
  const navigationIdRef = useRef(0);
  const pendingNavigationRef = useRef<NavigationToken | null>(null);
  const mountedRef = useRef(true);
  const jobRef = useRef<Job | null>(null);
  const {
    committedRecordQueryRef,
    intendedRecordQueryRef,
    listRequestIdRef,
    detailRequestIdRef,
    selectedRef,
    beginListRequest,
    isLatestListRequest,
    loadValidRecordPage,
    commitRecordPage,
    rollbackLatestListRequest,
    requestRecordDetail,
    clearSelectedRecord,
    refreshCurrentRecordPage,
  } = records;

  const { cancelAnalysisPoll, suspendAnalysisPoll, resumeAnalysisPoll, startAnalysisPoll } = useAnalysisPolling({
    mountedRef,
    activeJobIdRef,
    jobRef,
    setNotice,
    commitJobSummary: next => commitJobSummary(next),
    refreshCurrentRecordPage,
  });

  const cancelForegroundOperations = () => {
    operationIdRef.current += 1;
    busyOperationIdRef.current = null;
    taskActionOperationIdRef.current = null;
    setBusy(false);
    setTaskActionBusy(false);
  };

  const setActiveJob = (nextJob: Job | null) => {
    const nextJobId = nextJob?.id ?? null;
    if (activeJobIdRef.current !== nextJobId) {
      cancelAnalysisPoll();
      cancelForegroundOperations();
      activeJobIdRef.current = nextJobId;
      activeJobGenerationRef.current += 1;
    } else {
      activeJobIdRef.current = nextJobId;
    }
    jobRef.current = nextJob;
    setJob(nextJob);
  };

  const captureJobOperation = (): JobOperationToken => ({
    operationId: ++operationIdRef.current,
    jobId: activeJobIdRef.current,
    generation: activeJobGenerationRef.current,
  });

  const isJobOperationCurrent = (token: JobOperationToken) => (
    mountedRef.current && operationIdRef.current === token.operationId
    && activeJobIdRef.current === token.jobId
    && activeJobGenerationRef.current === token.generation
  );

  const startBusyOperation = (token: JobOperationToken) => {
    busyOperationIdRef.current = token.operationId;
    setBusy(true);
  };

  const finishBusyOperation = (token: JobOperationToken) => {
    if (busyOperationIdRef.current !== token.operationId) return;
    busyOperationIdRef.current = null;
    setBusy(false);
  };

  const startTaskActionOperation = (token: JobOperationToken) => {
    taskActionOperationIdRef.current = token.operationId;
    setTaskActionBusy(true);
  };

  const finishTaskActionOperation = (token: JobOperationToken) => {
    if (taskActionOperationIdRef.current !== token.operationId) return;
    taskActionOperationIdRef.current = null;
    setTaskActionBusy(false);
  };

  const commitJobSummary = (nextJob: Job) => {
    if (activeJobIdRef.current !== nextJob.id) return;
    setActiveJob(nextJob);
    setJobs((current) => current.map((item) => item.id === nextJob.id ? nextJob : item));
  };

  const refresh = async (
    jobId?: string,
    options: { page?: number; pageSize?: number; filter?: string } = {},
  ) => {
    refreshAbortRef.current?.abort();
    const request = new AbortController(); refreshAbortRef.current = request;
    const committedQuery = committedRecordQueryRef.current;
    const requestedJobId = jobId ?? committedQuery.jobId;
    let query: RecordQueryIdentity = {
      jobId: requestedJobId,
      page: options.page ?? (jobId && jobId !== committedQuery.jobId ? 1 : committedQuery.page),
      pageSize: options.pageSize ?? committedQuery.pageSize,
      filter: options.filter ?? committedQuery.filter,
    };
    const requestId = beginListRequest(query);
    try {
      const [nextJobs, nextSections, nextModels, nextPlatforms] = await Promise.all([
        api<Job[]>("/api/jobs", { signal: request.signal }),
        api<AnalysisSection[]>("/api/sections", { signal: request.signal }),
        api<ModelConfig[]>("/api/model-configs", { signal: request.signal }),
        api<Platform[]>("/api/platforms", { signal: request.signal }),
      ]);
      if (!isLatestListRequest(requestId, query)) return false;
      const target = nextJobs.find((item) => item.id === jobId)
        ?? nextJobs.find((item) => item.id === committedQuery.jobId)
        ?? nextJobs[0];
      if (!target) {
        query = { ...EMPTY_RECORD_QUERY, pageSize: committedQuery.pageSize };
        intendedRecordQueryRef.current = query;
        if (!isLatestListRequest(requestId, query)) return false;
        setJobs(nextJobs);
        setSections(nextSections);
        setModels(nextModels);
        setPlatforms(nextPlatforms);
        setActiveJob(null);
        const emptyPage = { ...EMPTY_RECORD_PAGE, pageSize: query.pageSize };
        commitRecordPage(query, emptyPage);
        clearSelectedRecord();
        return true;
      }
      const taskChanged = target.id !== committedQuery.jobId;
      query = {
        jobId: target.id,
        page: options.page ?? (taskChanged ? 1 : query.page),
        pageSize: query.pageSize,
        filter: query.filter,
      };
      intendedRecordQueryRef.current = query;
      const [freshJob, pageResult] = await Promise.all([
        api<Job>(`/api/jobs/${target.id}`, { signal: request.signal }),
        loadValidRecordPage(query, requestId),
      ]);
      if (!pageResult || !isLatestListRequest(requestId, pageResult.query)) return false;
      setJobs(nextJobs);
      setSections(nextSections);
      setModels(nextModels);
      setPlatforms(nextPlatforms);
      setActiveJob(freshJob);
      commitRecordPage(pageResult.query, pageResult.recordPage);
      const currentSelected = selectedRef.current;
      if (
        currentSelected
        && pageResult.recordPage.items.some((item) => item.id === currentSelected.id)
      ) {
        await requestRecordDetail(currentSelected.id, target.id);
      }
      return true;
    } catch (error) {
      rollbackLatestListRequest(
        requestId,
        intendedRecordQueryRef.current,
        error,
        "刷新任务失败",
      );
      if (listRequestIdRef.current === requestId) throw error;
      return false;
    }
  };

  const navigateToJob = async (jobId: string) => {
    if (jobId === activeJobIdRef.current && pendingNavigationRef.current === null) {
      return true;
    }
    const navigation: NavigationToken = {
      navigationId: ++navigationIdRef.current,
      jobId,
    };
    pendingNavigationRef.current = navigation;
    const pollSuspension = activeJobIdRef.current
      ? suspendAnalysisPoll(activeJobIdRef.current)
      : null;
    cancelForegroundOperations();
    try {
      return await refresh(jobId);
    } finally {
      if (pendingNavigationRef.current === navigation) {
        pendingNavigationRef.current = null;
        resumeAnalysisPoll(pollSuspension);
      }
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    refresh().catch((error) => {
      if (mountedRef.current) setNotice(error.message);
    });
    return () => {
      mountedRef.current = false;
      refreshAbortRef.current?.abort();
      cancelAnalysisPoll();
      listRequestIdRef.current += 1;
      detailRequestIdRef.current += 1;
      operationIdRef.current += 1;
    };
  }, []);

  const handleJobsDeleted = async (deletedIds: string[]) => {
    if (selectedRef.current && deletedIds.includes(selectedRef.current.jobId)) {
      clearSelectedRecord();
    }
    const refreshed = await refresh(job && deletedIds.includes(job.id) ? undefined : job?.id);
    if (refreshed) setNotice("解析任务已删除");
  };

  const refreshProgress = async () => {
    if (refreshPendingRef.current) return;
    refreshPendingRef.current = true;
    setRefreshing(true);
    const jobId = activeJobIdRef.current;
    const generation = activeJobGenerationRef.current;
    const suspension = jobId ? suspendAnalysisPoll(jobId) : null;
    try {
      const updated = await refresh(jobId ?? undefined);
      if (updated && mountedRef.current && activeJobIdRef.current === jobId && activeJobGenerationRef.current === generation) {
        setNotice("任务进度已刷新");
      }
    } catch (error) {
      if (mountedRef.current && activeJobIdRef.current === jobId) setNotice(error instanceof Error ? error.message : "刷新失败，请重试");
    } finally {
      resumeAnalysisPoll(suspension);
      refreshPendingRef.current = false;
      if (mountedRef.current) setRefreshing(false);
    }
  };

  const operations: JobOperationHelpers = {
    captureJobOperation,
    isJobOperationCurrent,
    startBusyOperation,
    finishBusyOperation,
    startTaskActionOperation,
    finishTaskActionOperation,
  };

  return {
    jobs,
    job,
    sections,
    models,
    platforms,
    busy,
    taskActionBusy,
    refreshing,
    mountedRef,
    activeJobIdRef,
    pendingNavigationRef,
    operations,
    poll: { cancelAnalysisPoll, suspendAnalysisPoll, resumeAnalysisPoll, startAnalysisPoll },
    commitJobSummary,
    refresh,
    navigateToJob,
    handleJobsDeleted,
    refreshProgress,
  };
}
