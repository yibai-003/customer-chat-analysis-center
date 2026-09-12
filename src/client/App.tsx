import { useEffect, useRef, useState } from "react";
import type { AnalysisCapacity, AnalysisField, AnalysisJobOptions, AnalysisSection, ImportJob, Job, ModelConfig, RecordDetail, RecordPage, WorkbookPreview } from "../shared/types";
import { AnalysisProgress } from "./components/AnalysisProgress";
import { AnalysisRunDialog } from "./components/AnalysisRunDialog";
import { JobList } from "./components/JobList";
import { ImagePreviewDialog } from "./components/ImagePreviewDialog";
import { ImportPreviewDialog } from "./components/ImportPreviewDialog";
import { ImportProgressDialog } from "./components/ImportProgressDialog";
import { KnowledgeWorkspace } from "./components/knowledge/KnowledgeWorkspace";
import { ModelConfigDialog } from "./components/ModelConfigDialog";
import { RecordPager } from "./components/RecordPager";
import { SectionConfigDialog } from "./components/SectionConfigDialog";

const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(body.error || "请求失败");
  return body.data as T;
};

const labels: Record<string, string> = {
  pending: "待解析", processing: "解析中", completed: "已完成",
  failed: "失败", needs_review: "需复核", confirmed: "已确认",
};

const DEFAULT_PAGE_SIZE = 50;
const EMPTY_RECORD_PAGE: RecordPage = {
  items: [],
  total: 0,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

interface RecordQueryIdentity {
  jobId: string | null;
  page: number;
  pageSize: number;
  filter: string;
}

const EMPTY_RECORD_QUERY: RecordQueryIdentity = {
  jobId: null,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  filter: "all",
};

interface JobOperationToken {
  operationId: number;
  jobId: string | null;
  generation: number;
}

interface NavigationToken {
  navigationId: number;
  jobId: string;
}

interface AnalysisPollController {
  id: number;
  jobId: string;
  generation: number;
  previousProgress: string;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  suspended: boolean;
  cancelled: boolean;
}

interface AnalysisPollSuspension {
  controller: AnalysisPollController;
  generation: number;
}

type AnalysisRunOptions = Required<Pick<AnalysisJobOptions, "concurrency" | "batchSize">>;

function analysisProgressKey(job: Job) {
  return [
    job.totalRecords,
    job.completedRecords,
    job.failedRecords,
    job.totalFields,
    job.completedFields,
    job.failedFields,
    job.skippedFields,
  ].join(":");
}

export default function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [recordPage, setRecordPage] = useState<RecordPage>(EMPTY_RECORD_PAGE);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selected, setSelected] = useState<RecordDetail | null>(null);
  const [sections, setSections] = useState<AnalysisSection[]>([]);
  const [activeFields, setActiveFields] = useState<AnalysisField[]>([]);
  const [activeSection, setActiveSection] = useState("reception");
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [dialog, setDialog] = useState<"model" | "section" | null>(null);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [knowledgeSection, setKnowledgeSection] = useState<AnalysisSection | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const [taskActionBusy, setTaskActionBusy] = useState(false);
  const [importPreview, setImportPreview] = useState<WorkbookPreview | null>(null);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [importJobId, setImportJobId] = useState<string | null>(null);
  const [analysisCapacity, setAnalysisCapacity] = useState<AnalysisCapacity | null>(null);
  const listRequestIdRef = useRef(0);
  const intendedRecordQueryRef = useRef<RecordQueryIdentity>(EMPTY_RECORD_QUERY);
  const committedRecordQueryRef = useRef<RecordQueryIdentity>(EMPTY_RECORD_QUERY);
  const recordPageRef = useRef<RecordPage>(EMPTY_RECORD_PAGE);
  const detailRequestIdRef = useRef(0);
  const selectedRef = useRef<RecordDetail | null>(null);
  const detailRevisionRef = useRef(0);
  const detailDirtyRef = useRef(false);
  const activeJobIdRef = useRef<string | null>(null);
  const activeJobGenerationRef = useRef(0);
  const operationIdRef = useRef(0);
  const busyOperationIdRef = useRef<number | null>(null);
  const taskActionOperationIdRef = useRef<number | null>(null);
  const navigationIdRef = useRef(0);
  const pendingNavigationRef = useRef<NavigationToken | null>(null);
  const pendingImportOriginRef = useRef<JobOperationToken | null>(null);
  const mountedRef = useRef(true);
  const jobRef = useRef<Job | null>(null);
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
    analysisPollRef.current = null;
  };

  const suspendAnalysisPoll = (jobId: string): AnalysisPollSuspension | null => {
    const controller = analysisPollRef.current;
    if (!controller || controller.jobId !== jobId || controller.cancelled) return null;
    clearAnalysisPollTimeout(controller);
    controller.suspended = true;
    controller.generation += 1;
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

  const setSelectedRecord = (nextSelected: RecordDetail | null) => {
    selectedRef.current = nextSelected;
    if (!nextSelected) detailDirtyRef.current = false;
    setSelected(nextSelected);
  };

  const clearSelectedRecord = () => {
    detailRequestIdRef.current += 1;
    detailRevisionRef.current += 1;
    detailDirtyRef.current = false;
    setSelectedRecord(null);
  };

  const editSelectedRecord = (nextSelected: RecordDetail) => {
    detailRequestIdRef.current += 1;
    detailRevisionRef.current += 1;
    detailDirtyRef.current = true;
    selectedRef.current = nextSelected;
    setSelected(nextSelected);
  };

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
    operationIdRef.current === token.operationId
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

  const fetchRecordPage = (query: RecordQueryIdentity) => {
    if (!query.jobId) throw new Error("记录任务不存在");
    const params = new URLSearchParams({
      page: String(query.page),
      pageSize: String(query.pageSize),
    });
    if (query.filter !== "all") params.set("status", query.filter);
    return api<RecordPage>(`/api/jobs/${query.jobId}/records?${params}`);
  };

  const isLatestListRequest = (requestId: number, query: RecordQueryIdentity) => (
    listRequestIdRef.current === requestId
    && intendedRecordQueryRef.current === query
  );

  const beginListRequest = (query: RecordQueryIdentity) => {
    const requestId = ++listRequestIdRef.current;
    intendedRecordQueryRef.current = query;
    detailRequestIdRef.current += 1;
    return requestId;
  };

  const loadValidRecordPage = async (
    initialQuery: RecordQueryIdentity,
    requestId: number,
  ): Promise<{ query: RecordQueryIdentity; recordPage: RecordPage } | null> => {
    let query = initialQuery;
    while (true) {
      const nextRecordPage = await fetchRecordPage(query);
      if (!isLatestListRequest(requestId, query)) return null;
      const lastPage = Math.max(1, Math.ceil(nextRecordPage.total / query.pageSize));
      if (nextRecordPage.total === 0) {
        if (query.page !== 1) {
          query = { ...query, page: 1 };
          intendedRecordQueryRef.current = query;
        }
        return {
          query,
          recordPage: { ...nextRecordPage, page: 1, pageSize: query.pageSize },
        };
      }
      if (query.page <= lastPage) {
        return {
          query,
          recordPage: { ...nextRecordPage, page: query.page, pageSize: query.pageSize },
        };
      }
      query = { ...query, page: lastPage };
      intendedRecordQueryRef.current = query;
    }
  };

  const commitRecordPage = (query: RecordQueryIdentity, nextRecordPage: RecordPage) => {
    intendedRecordQueryRef.current = query;
    committedRecordQueryRef.current = query;
    recordPageRef.current = nextRecordPage;
    setRecordPage(nextRecordPage);
    setPage(query.page);
    setPageSize(query.pageSize);
    setFilter(query.filter);
    const currentSelected = selectedRef.current;
    if (
      currentSelected
      && (
        currentSelected.jobId !== query.jobId
        || !nextRecordPage.items.some((item) => item.id === currentSelected.id)
      )
    ) {
      clearSelectedRecord();
    }
  };

  const rollbackLatestListRequest = (
    requestId: number,
    query: RecordQueryIdentity,
    error: unknown,
    fallbackMessage: string,
  ) => {
    if (!isLatestListRequest(requestId, query)) return;
    const committedQuery = committedRecordQueryRef.current;
    intendedRecordQueryRef.current = committedQuery;
    setPage(committedQuery.page);
    setPageSize(committedQuery.pageSize);
    setFilter(committedQuery.filter);
    setNotice(error instanceof Error ? error.message : fallbackMessage);
  };

  const requestRecordDetail = async (
    recordId: string,
    jobId: string,
    options: { explicit?: boolean; remainsCurrent?: () => boolean } = {},
  ) => {
    if (!options.explicit && detailDirtyRef.current && selectedRef.current?.id === recordId) {
      return false;
    }
    if (options.explicit) {
      detailRevisionRef.current += 1;
      detailDirtyRef.current = false;
    }
    const requestId = ++detailRequestIdRef.current;
    const detailRevision = detailRevisionRef.current;
    const listRequestId = listRequestIdRef.current;
    const query = intendedRecordQueryRef.current;
    try {
      const nextDetail = await api<RecordDetail>(`/api/records/${recordId}`);
      const remainsCurrent = (
        detailRequestIdRef.current === requestId
        && detailRevisionRef.current === detailRevision
        && !detailDirtyRef.current
        && listRequestIdRef.current === listRequestId
        && intendedRecordQueryRef.current === query
        && query.jobId === jobId
        && nextDetail.jobId === jobId
        && recordPageRef.current.items.some((item) => item.id === recordId)
        && (options.remainsCurrent?.() ?? true)
      );
      if (remainsCurrent) setSelectedRecord(nextDetail);
      return remainsCurrent;
    } catch (error) {
      if (
        detailRequestIdRef.current === requestId
        && (options.remainsCurrent?.() ?? true)
      ) {
        setNotice(error instanceof Error ? error.message : "记录详情加载失败");
      }
      return false;
    }
  };

  const requestPage = async (
    query: RecordQueryIdentity,
    fallbackMessage: string,
    remainsCurrent: () => boolean = () => true,
  ) => {
    const requestId = beginListRequest(query);
    try {
      const result = await loadValidRecordPage(query, requestId);
      if (!result || !remainsCurrent()) return false;
      commitRecordPage(result.query, result.recordPage);
      return true;
    } catch (error) {
      if (remainsCurrent()) {
        rollbackLatestListRequest(requestId, intendedRecordQueryRef.current, error, fallbackMessage);
      }
      return false;
    }
  };

  const refresh = async (
    jobId?: string,
    options: { page?: number; pageSize?: number; filter?: string } = {},
  ) => {
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
        api<Job[]>("/api/jobs"), api<AnalysisSection[]>("/api/sections"), api<ModelConfig[]>("/api/model-configs"),
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
        api<Job>(`/api/jobs/${target.id}`),
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
  useEffect(() => {
    if (!currentSection) return;
    api<AnalysisField[]>(`/api/sections/${currentSection.id}/fields`).then(setActiveFields).catch((error) => setNotice(error.message));
  }, [currentSection?.id]);

  const changeRecordPage = async (nextPage: number) => {
    const committedQuery = committedRecordQueryRef.current;
    if (!committedQuery.jobId) return;
    setPage(nextPage);
    await requestPage({ ...committedQuery, page: nextPage }, "记录分页加载失败");
  };

  const changePageSize = async (nextPageSize: number) => {
    const committedQuery = committedRecordQueryRef.current;
    if (!committedQuery.jobId) return;
    setPage(1);
    setPageSize(nextPageSize);
    await requestPage(
      { ...committedQuery, page: 1, pageSize: nextPageSize },
      "记录分页加载失败",
    );
  };

  const changeFilter = async (nextFilter: string) => {
    const committedQuery = committedRecordQueryRef.current;
    setFilter(nextFilter);
    setPage(1);
    if (!committedQuery.jobId) return;
    await requestPage(
      { ...committedQuery, page: 1, filter: nextFilter },
      "记录筛选失败",
    );
  };

  const commitImport = async (file: File) => {
    const operation = captureJobOperation();
    startBusyOperation(operation); setNotice("");
    try {
      const form = new FormData(); form.append("file", file);
      if (currentSection) form.append("sectionId", currentSection.id);
      const created = await api<ImportJob>("/api/jobs/import", { method: "POST", body: form });
      if (!isJobOperationCurrent(operation)) return;
      pendingImportOriginRef.current = operation;
      setImportJobId(created.id); setNotice("文件已提交后台导入");
    } catch (error) {
      if (isJobOperationCurrent(operation)) {
        setNotice(error instanceof Error ? error.message : "导入失败");
      }
    } finally { finishBusyOperation(operation); }
  };
  const importFile = async (file: File) => {
    const operation = captureJobOperation();
    startBusyOperation(operation); setNotice("");
    try {
      const form = new FormData(); form.append("file", file);
      if (currentSection) form.append("sectionId", currentSection.id);
      const preview = await api<WorkbookPreview>("/api/jobs/import-preview", { method: "POST", body: form });
      if (!isJobOperationCurrent(operation)) return;
      setPendingImportFile(file); setImportPreview(preview);
    } catch (error) {
      if (isJobOperationCurrent(operation)) {
        setNotice(error instanceof Error ? error.message : "读取 Excel 失败");
      }
    } finally { finishBusyOperation(operation); }
  };
  const handleImportCompleted = (jobId: string) => {
    const origin = pendingImportOriginRef.current;
    pendingImportOriginRef.current = null;
    setImportJobId(null);
    if (!origin || !isJobOperationCurrent(origin)) return;
    void refresh(jobId).then((refreshed) => {
      if (refreshed && activeJobIdRef.current === jobId) {
        setNotice("文件已导入，可以开始解析");
      }
    }).catch((error) => {
      if (activeJobIdRef.current === origin.jobId && pendingNavigationRef.current === null) {
        setNotice(error instanceof Error ? error.message : "刷新导入任务失败");
      }
    });
  };

  const refreshCurrentRecordPage = async (
    jobId: string,
    remainsCurrent: () => boolean,
  ) => {
    if (!remainsCurrent()) return false;
    const query = intendedRecordQueryRef.current;
    if (!query.jobId || query.jobId !== jobId) return false;
    const refreshed = await requestPage(
      { ...query },
      "解析进度刷新失败",
      remainsCurrent,
    );
    if (!refreshed || !remainsCurrent()) return false;
    const currentSelected = selectedRef.current;
    if (
      currentSelected
      && recordPageRef.current.items.some((item) => item.id === currentSelected.id)
    ) {
      await requestRecordDetail(currentSelected.id, query.jobId, { remainsCurrent });
    }
    return remainsCurrent();
  };

  async function pollAnalysisJob(
    controller: AnalysisPollController,
    generation: number,
  ) {
    if (!isAnalysisPollCurrent(controller, generation)) return;
    try {
      const current = await api<Job>(`/api/jobs/${controller.jobId}`);
      if (!isAnalysisPollCurrent(controller, generation)) return;
      commitJobSummary(current);
      const nextProgress = analysisProgressKey(current);
      const terminal = current.status !== "processing";
      if (terminal || nextProgress !== controller.previousProgress) {
        await refreshCurrentRecordPage(
          controller.jobId,
          () => isAnalysisPollCurrent(controller, generation),
        );
        if (!isAnalysisPollCurrent(controller, generation)) return;
      }
      controller.previousProgress = nextProgress;
      if (terminal) {
        cancelAnalysisPoll(controller.jobId);
        if (mountedRef.current) setNotice("解析完成，请检查需复核记录");
        return;
      }
      scheduleAnalysisPoll(controller);
    } catch (error) {
      if (!isAnalysisPollCurrent(controller, generation)) return;
      setNotice(error instanceof Error ? error.message : "解析状态刷新失败");
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
    };
    analysisPollRef.current = controller;
    scheduleAnalysisPoll(controller);
  };

  const analyzeRecord = async (recordId: string) => {
    if (!job || !currentSection) return;
    const operation = captureJobOperation();
    const operationJobId = job.id;
    startBusyOperation(operation); setNotice("");
    try {
      await api(`/api/records/${recordId}/analyze`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionId: currentSection.id }),
      });
      if (!isJobOperationCurrent(operation)) return;
      const refreshed = await refresh(operationJobId);
      if (refreshed && isJobOperationCurrent(operation)) {
        setNotice("解析完成，请检查需复核记录");
      }
    } catch (error) {
      if (isJobOperationCurrent(operation)) {
        setNotice(error instanceof Error ? error.message : "解析失败");
      }
    } finally { finishBusyOperation(operation); }
  };

  const requestBatchAnalysis = async () => {
    if (!job || !currentSection) return;
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
  const saveReview = async () => {
    if (!selected || !job) return;
    const operation = captureJobOperation();
    const operationJobId = job.id;
    const recordId = selected.id;
    const detailRevision = detailRevisionRef.current;
    const sectionReview = currentSection ? selected.sectionReviews?.[currentSection.id] : undefined;
    await api(`/api/records/${selected.id}`, {
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
    const refreshed = await refresh(operationJobId);
    if (refreshed && isJobOperationCurrent(operation)) setNotice("复核结果已保存");
  };
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

  if (knowledgeSection) {
    return <KnowledgeWorkspace
      section={knowledgeSection}
      onBack={() => setKnowledgeSection(null)}
    />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">析</span><div><strong>客服解析中心</strong><small>CHAT INTELLIGENCE WORKSPACE</small></div></div>
        <div className="top-actions">
          <label className="button primary">＋ 导入 Excel<input hidden type="file" accept=".xlsx" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} /></label>
          <button className="button ghost" onClick={() => setDialog("section")}>板块配置</button>
          <button className="button ghost" onClick={() => setDialog("model")}>模型配置</button>
          <button className="button export" disabled={!job || !currentSection} onClick={() => job && currentSection && (window.location.href = `/api/jobs/${job.id}/export?sections=${currentSection.id}`)}>导出结果 ↗</button>
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <div className="sidebar-title"><span>解析任务</span><b>{String(jobs.length).padStart(2, "0")}</b></div>
          {!jobs.length ? <div className="side-empty">导入 Excel 文件<br />建立解析任务</div> : <JobList jobs={jobs} sections={sections} selectedId={job?.id} onSelect={(id) => void navigateToJob(id).catch((error) => setNotice(error instanceof Error ? error.message : "切换任务失败"))} onDeleted={handleJobsDeleted} />}
          <div className="sidebar-title section-title"><span>解析板块</span><button onClick={() => setDialog("section")}>管理</button></div>
          <nav>{sections.filter((s) => !s.parentId).map((parent) => <div className="section-group" key={parent.id}><div className="parent">╰ {parent.name}</div>{sections.filter((s) => s.parentId === parent.id).map((child) => <div className={`section-entry ${activeSection === child.id ? "active" : ""}`} key={child.id}><button className="section-select" disabled={Boolean(job?.sectionId && job.sectionId !== child.id)} title={job?.sectionId && job.sectionId !== child.id ? "当前任务已绑定其他解析板块" : undefined} onClick={() => setActiveSection(child.id)}><span />{child.name}<i /></button><button className="section-knowledge" aria-label={`打开${child.name}知识库`} title="知识库" onClick={() => setKnowledgeSection(child)}>知</button></div>)}</div>)}</nav>
          <div className="server-state"><i />服务端已连接 <b>LOCAL</b></div>
        </aside>

        <section className="content">
          <div className="content-header">
            <div><small>ANALYSIS QUEUE</small><h1>{job?.originalFilename ?? "等待导入解析文件"}</h1><p>{job ? `共 ${job.totalRecords} 条记录，当前板块：${currentSection?.name}` : "导入包含聊天截图的 Excel，开始客服分析"}</p>{job && <AnalysisProgress job={job} />}</div>
            {job && <div className="content-actions"><select aria-label="按记录状态筛选" value={filter} onChange={(e) => void changeFilter(e.target.value)}><option value="all">全部状态</option><option value="pending">待解析</option><option value="completed">已完成</option><option value="needs_review">需复核</option><option value="failed">失败</option></select>{job.status === "processing" && <><button className="button light" disabled={taskActionBusy} onClick={() => taskAction("pause")}>暂停</button><button className="button light" disabled={taskActionBusy} onClick={() => taskAction("cancel")}>取消</button></>}{job.status === "failed" && <button className="button light" disabled={taskActionBusy} onClick={() => taskAction("retry-failed")}>重试失败</button>}<button className="button dark" disabled={busy || taskActionBusy || job.status === "processing" || job.status === "cancelled"} onClick={() => void requestBatchAnalysis()}>{busy ? "解析中..." : job.status === "paused" ? "继续解析 →" : "批量解析 →"}</button></div>}
          </div>
          {notice && <div className="notice">{notice}</div>}
          {!job ? <div className="blank"><div className="upload-art"><b>XLSX</b><i>＋</i></div><h2>把聊天记录带进来</h2><p>支持带嵌入图片和辅助字段的 .xlsx 文件</p><label className="button primary large">选择文件<input hidden type="file" accept=".xlsx" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} /></label></div> :
            <div className="record-list">
              <div className="list-head"><span />记录<span>来源字段</span><span>解析状态</span><span>复核</span><span>操作</span></div>
              {recordPage.items.map((record, index) => <button key={record.id} className={`record ${selected?.id === record.id ? "active" : ""}`} onClick={() => job && void requestRecordDetail(record.id, job.id, { explicit: true })}>
                <span className="checkbox">{index === 0 ? "✓" : ""}</span>
                <span className="record-main"><img src={record.imageUrl} alt="" loading="lazy" decoding="async" /><span><strong>记录 {String(record.rowNumber).padStart(2, "0")}</strong><small>{record.sheetName} · 第 {record.rowNumber} 行</small></span></span>
                <span className="field-tags">{Object.entries(record.sourceFields).slice(0, 2).map(([key, value]) => <em key={key}>{key}: {value || "空"}</em>)}</span>
                <span className={`status ${record.status}`}><i />{labels[record.status]}</span>
                <span className={`review ${record.reviewStatus}`}>{labels[record.reviewStatus] ?? "未复核"}</span><span className="view">查看 →</span>
              </button>)}
              {!recordPage.items.length && <div className="no-results">当前筛选下没有记录</div>}
              <RecordPager
                page={page}
                pageSize={pageSize}
                total={recordPage.total}
                onPageChange={(nextPage) => void changeRecordPage(nextPage)}
                onPageSizeChange={(nextPageSize) => void changePageSize(nextPageSize)}
              />
            </div>}
        </section>

        <aside className="detail">
          {selected ? <Detail record={selected} section={currentSection} fields={activeFields} busy={busy || job?.status === "processing"} setRecord={editSelectedRecord} onAnalyze={() => void analyzeRecord(selected.id)} onRetry={retryField} onSave={saveReview} onPreviewImage={(src, alt) => setPreviewImage({ src, alt })} /> : <div className="detail-empty"><b>01</b><h2>选择一条记录</h2><p>查看原图、辅助字段和 AI 解析结果</p></div>}
        </aside>
      </main>

      {dialog === "model" && <ModelConfigDialog models={models} close={() => setDialog(null)} saved={() => { setDialog(null); refresh(); }} />}
      {dialog === "section" && <SectionConfigDialog sections={sections} close={() => setDialog(null)} saved={() => { setDialog(null); refresh(); }} />}
      {analysisCapacity && <AnalysisRunDialog capacity={analysisCapacity} onCancel={() => setAnalysisCapacity(null)} onConfirm={(options) => void startBatchAnalysis(options)} />}
      {previewImage && <ImagePreviewDialog {...previewImage} onClose={() => setPreviewImage(null)} />}
      {importPreview && pendingImportFile && <ImportPreviewDialog preview={importPreview} busy={busy} onCancel={() => { setImportPreview(null); setPendingImportFile(null); }} onConfirm={async () => { const file = pendingImportFile; setImportPreview(null); setPendingImportFile(null); await commitImport(file); }} />}
      {importJobId && <ImportProgressDialog importJobId={importJobId} onCompleted={handleImportCompleted} onClose={() => setImportJobId(null)} />}
    </div>
  );
}

export function formatFieldResult(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

export function Detail({ record, section, fields, setRecord, onAnalyze, onRetry, onSave, busy, onPreviewImage = () => undefined }: { record: RecordDetail; section?: AnalysisSection; fields: AnalysisField[]; setRecord: (r: RecordDetail) => void; onAnalyze: () => void; onRetry: (fieldKey: string) => void; onSave: () => void; busy: boolean; onPreviewImage?: (src: string, alt: string) => void }) {
  const run = section && record.analysisRuns.find((item) => item.sectionId === section.id);
  const fieldRuns = section ? record.fieldRuns.filter((item) => item.sectionId === section.id) : [];
  const displayFields: AnalysisField[] = (fields.length ? fields : (section?.outputSchema ?? []).map((field, index) => ({ ...field, id: field.key, sectionId: section?.id ?? "", prompt: section?.prompt ?? "", required: Boolean(field.required), imageEnabled: section?.imageEnabled !== false, dependsOn: [], sortOrder: index, isEnabled: true, exportEnabled: true }))).filter((field) => field.exportEnabled !== false);
  const runtimeResult = fieldRuns.length ? Object.assign({}, ...fieldRuns.slice().reverse().filter((item) => item.status === "completed" || item.status === "needs_review").map((item) => item.result)) : run?.result ?? {};
  const currentReview = section ? record.sectionReviews?.[section.id] : undefined;
  const result = Object.fromEntries(displayFields.map((field) => [
    field.key,
    currentReview?.humanResult && field.key in currentReview.humanResult
      ? currentReview.humanResult[field.key]
      : !currentReview && record.humanResult && field.key in record.humanResult
        ? record.humanResult[field.key]
      : runtimeResult[field.key],
  ]));
  const change = (key: string, value: string) => {
    const nextResult = { ...result, [key]: value };
    setRecord({
      ...record,
      humanResult: nextResult,
      sectionReviews: section
        ? { ...record.sectionReviews, [section.id]: { humanResult: nextResult, reviewStatus: currentReview?.reviewStatus ?? "pending", reviewNote: currentReview?.reviewNote ?? record.reviewNote } }
        : record.sectionReviews,
    });
  };
  const changeNote = (value: string) => setRecord({
    ...record,
    reviewNote: value,
    sectionReviews: section
      ? { ...record.sectionReviews, [section.id]: { humanResult: currentReview?.humanResult ?? result, reviewStatus: currentReview?.reviewStatus ?? "pending", reviewNote: value } }
      : record.sectionReviews,
  });
  return <div className="detail-scroll"><div className="detail-head"><div><small>RECORD {String(record.rowNumber).padStart(2, "0")}</small><h2>{section?.name ?? "解析详情"}</h2></div><span className={`status ${record.status}`}><i />{labels[record.status]}</span></div><button type="button" className="detail-image-button" aria-label="打开聊天截图预览" title="打开大图" onClick={() => onPreviewImage(record.imageUrl, `记录 ${String(record.rowNumber).padStart(2, "0")} 聊天截图`)}><figure><img src={record.imageUrl} alt={`记录 ${String(record.rowNumber).padStart(2, "0")} 聊天截图`} loading="eager" decoding="async" /><figcaption>ORIGINAL CHAT SCREENSHOT · 点击查看大图</figcaption></figure></button><div className="detail-block"><h3>辅助字段</h3>{Object.entries(record.sourceFields).map(([key, value]) => <div className="source-field" key={key}><span>{key}</span><strong>{value || "未填写"}</strong></div>)}</div><div className="detail-block"><h3>字段解析结果 <span>{fieldRuns.length ? `· ${fieldRuns.length} 次字段运行` : run ? `· ${run.createdAt.slice(11, 16)}` : ""}</span></h3>{displayFields.map((field) => {
    const fieldRun = fieldRuns.find((item) => item.fieldKey === field.key);
    const retryable = fieldRun && ["failed", "needs_review", "skipped"].includes(fieldRun.status);
    return <label className="result-field" key={field.key}><span>{field.label} <em className={`field-status ${fieldRun?.status ?? "pending"}`}>{labels[fieldRun?.status ?? "pending"] ?? "待解析"}</em>{retryable && <button type="button" className="field-retry" disabled={busy} onClick={() => onRetry(field.key)}>重试</button>}</span><textarea rows={field.type === "string" || field.type === "object" ? 4 : 1} value={formatFieldResult(result[field.key])} onChange={(e) => change(field.key, e.target.value)} />{fieldRun?.evidence && <small className="field-evidence">依据：{fieldRun.evidence}</small>}{fieldRun?.errorMessage && <small className="form-error" role="alert">{fieldRun.errorMessage}</small>}</label>;
  })}</div><label className="result-field"><span>复核备注</span><textarea rows={2} value={currentReview?.reviewNote ?? record.reviewNote} onChange={(e) => changeNote(e.target.value)} /></label><div className="detail-actions"><button className="button dark" disabled={busy} onClick={onAnalyze}>{fieldRuns.length ? "重新解析 →" : "开始解析 →"}</button><button className="button light" onClick={onSave}>保存复核</button></div></div>;
}
