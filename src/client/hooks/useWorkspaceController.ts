import { useReviewSave } from "./useReviewSave";
import { useImportWorkflow } from "./useImportWorkflow";
import type { JobOperationToken } from "./workspace-types";
import { useAnalysisPolling } from "./useAnalysisPolling";
import { useRecordWorkspace, EMPTY_RECORD_PAGE, EMPTY_RECORD_QUERY, type RecordQueryIdentity } from "./useRecordWorkspace";
import { useEffect, useRef, useState } from "react";
import type { AnalysisCapacity, AnalysisField, AnalysisJobOptions, AnalysisSection, Job, ModelConfig } from "../../shared/types";
import { api } from "../api";
import { analysisStatusMessage } from "../analysis-status";
import { useModelReadiness } from "./useModelReadiness";

interface NavigationToken {
  navigationId: number;
  jobId: string;
}

type AnalysisRunOptions = Required<Pick<AnalysisJobOptions, "concurrency" | "batchSize" | "maxPaidTokens">>;

export function useWorkspaceController() {
  const headerRef = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState(76);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [sections, setSections] = useState<AnalysisSection[]>([]);
  const [activeFields, setActiveFields] = useState<AnalysisField[]>([]);
  const [activeSection, setActiveSection] = useState("reception");
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [dialog, setDialog] = useState<"model" | "section" | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const records = useRecordWorkspace(setNotice);
  const {
    recordPage,
    page,
    pageSize,
    selected,
    filter,
    listRequestIdRef,
    intendedRecordQueryRef,
    committedRecordQueryRef,
    detailRequestIdRef,
    selectedRef,
    clearSelectedRecord,
    editSelectedRecord,
    isLatestListRequest,
    beginListRequest,
    loadValidRecordPage,
    commitRecordPage,
    rollbackLatestListRequest,
    requestRecordDetail,
    changeRecordPage,
    changePageSize,
    changeFilter,
    refreshCurrentRecordPage,
  } = records;
  const [knowledgeSection, setKnowledgeSection] = useState<AnalysisSection | null>(null);
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const measure = () => setHeaderHeight(header.getBoundingClientRect().height || 76);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, [knowledgeSection]);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const [taskActionBusy, setTaskActionBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshPendingRef = useRef(false);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const [analysisCapacity, setAnalysisCapacity] = useState<AnalysisCapacity | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const activeJobGenerationRef = useRef(0);
  const operationIdRef = useRef(0);
  const busyOperationIdRef = useRef<number | null>(null);
  const taskActionOperationIdRef = useRef<number | null>(null);
  const navigationIdRef = useRef(0);
  const pendingNavigationRef = useRef<NavigationToken | null>(null);
  const mountedRef = useRef(true);
  const jobRef = useRef<Job | null>(null);
  const { cancelAnalysisPoll, suspendAnalysisPoll, resumeAnalysisPoll, startAnalysisPoll } = useAnalysisPolling({ mountedRef, activeJobIdRef, jobRef, setNotice, commitJobSummary: next => commitJobSummary(next), refreshCurrentRecordPage });

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
      setAnalysisCapacity(null);
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
      const [nextJobs, nextSections, nextModels] = await Promise.all([
        api<Job[]>("/api/jobs", { signal: request.signal }), api<AnalysisSection[]>("/api/sections", { signal: request.signal }), api<ModelConfig[]>("/api/model-configs", { signal: request.signal }),
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
  useEffect(() => {
    if (job?.sectionId && job.sectionId !== activeSection) setActiveSection(job.sectionId);
  }, [job?.id, job?.sectionId]);

  const childSections = sections.filter((section) => section.parentId);
  const currentSection = sections.find((section) => section.id === activeSection) ?? childSections[0];
  const modelReadiness = useModelReadiness(models, activeFields);
  useEffect(() => {
    if (!currentSection) return;
    const request = new AbortController();
    setActiveFields([]);
    api<AnalysisField[]>(`/api/sections/${currentSection.id}/fields`, { signal: request.signal })
      .then(fields => { if (!request.signal.aborted) setActiveFields(fields); })
      .catch(error => { if (!request.signal.aborted) setNotice(error.message); });
    return () => request.abort();
  }, [currentSection?.id]);

  const {
    importPreview,
    setImportPreview,
    pendingImportFile,
    setPendingImportFile,
    selectingImportFile,
    setSelectingImportFile,
    importJobId,
    setImportJobId,
    commitImport,
    importFile,
    previewImport,
    handleImportCompleted,
  } = useImportWorkflow({ captureJobOperation, startBusyOperation, finishBusyOperation, isJobOperationCurrent, setNotice, refresh, activeJobIdRef, pendingNavigationRef });

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

  const requestBatchAnalysis = async () => {
    if (!job || !currentSection) return;
    if (!modelReadiness.ready) {
      setNotice("请先在模型配置中验证并启用对应的视觉模型和文本模型");
      setDialog("model");
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
    startBusyOperation(operation); setNotice("");
    try {
      let current = await api<Job>(`/api/jobs/${operationJobId}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionId, ...options }),
      });
      if (!isJobOperationCurrent(operation)) return;
      commitJobSummary(current);
      finishBusyOperation(operation);
      if (current.status === "processing") {
        startAnalysisPoll(current);
      } else {
        await refreshCurrentRecordPage(
          operationJobId,
          () => mountedRef.current && isJobOperationCurrent(operation),
        );
        if (mountedRef.current && isJobOperationCurrent(operation)) {
          setNotice("解析完成，请检查需复核记录");
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
  const saveReview = useReviewSave({ records, job, busy, currentSection, captureJobOperation, isJobOperationCurrent, startBusyOperation, finishBusyOperation, setNotice, refresh, suspendAnalysisPoll, resumeAnalysisPoll });

  const handleJobsDeleted = async (deletedIds: string[]) => {
    if (selectedRef.current && deletedIds.includes(selectedRef.current.jobId)) {
      clearSelectedRecord();
    }
    const refreshed = await refresh(job && deletedIds.includes(job.id) ? undefined : job?.id);
    if (refreshed) setNotice("解析任务已删除");
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

  return {
    headerRef,
    headerHeight,
    jobs,
    job,
    recordPage,
    page,
    pageSize,
    selected,
    sections,
    activeFields,
    activeSection,
    setActiveSection,
    models,
    dialog,
    setDialog,
    filter,
    busy,
    notice,
    setNotice,
    knowledgeSection,
    setKnowledgeSection,
    previewImage,
    setPreviewImage,
    taskActionBusy,
    importPreview,
    setImportPreview,
    pendingImportFile,
    setPendingImportFile,
    selectingImportFile,
    setSelectingImportFile,
    refreshing,
    importJobId,
    setImportJobId,
    analysisCapacity,
    setAnalysisCapacity,
    currentSection,
    refresh,
    navigateToJob,
    changeRecordPage,
    changePageSize,
    changeFilter,
    importFile,
    previewImport,
    commitImport,
    handleImportCompleted,
    analyzeRecord,
    requestBatchAnalysis,
    startBatchAnalysis,
    retryField,
    saveReview,
    handleJobsDeleted,
    taskAction,
    refreshProgress,
    requestRecordDetail,
    editSelectedRecord,
  };
}
