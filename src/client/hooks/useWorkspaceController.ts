import { useEffect, useRef, useState } from "react";
import type { AnalysisCapacity, AnalysisSection } from "../../shared/types";
import { useReviewSave } from "./useReviewSave";
import { useImportWorkflow } from "./useImportWorkflow";
import { useRecordWorkspace } from "./useRecordWorkspace";
import { useJobSelection } from "./useJobSelection";
import { useSectionCatalog } from "./useSectionCatalog";
import { useAnalysisActions } from "./useAnalysisActions";
import { useModelReadiness } from "./useModelReadiness";

export function useWorkspaceController({ canManageConfig = true }: { canManageConfig?: boolean } = {}) {
  const headerRef = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState(76);
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<"model" | "section" | "versions" | "platforms" | "users" | "audit" | "backups" | null>(null);
  const [knowledgeSection, setKnowledgeSection] = useState<AnalysisSection | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const [analysisCapacity, setAnalysisCapacity] = useState<AnalysisCapacity | null>(null);
  const records = useRecordWorkspace(setNotice);
  const selection = useJobSelection({ setNotice, records });
  const catalog = useSectionCatalog({ sections: selection.sections, setNotice });
  const modelReadiness = useModelReadiness(selection.models, catalog.activeFields);
  const importWorkflow = useImportWorkflow({
    ...selection.operations,
    platforms: selection.platforms,
    setNotice,
    refresh: selection.refresh,
    activeJobIdRef: selection.activeJobIdRef,
    pendingNavigationRef: selection.pendingNavigationRef,
  });
  const actions = useAnalysisActions({
    job: selection.job,
    currentSection: catalog.currentSection,
    selected: records.selected,
    modelReadiness,
    canManageConfig,
    mountedRef: selection.mountedRef,
    taskActionBusy: selection.taskActionBusy,
    setNotice,
    setDialog,
    setAnalysisCapacity,
    refresh: selection.refresh,
    refreshCurrentRecordPage: records.refreshCurrentRecordPage,
    commitJobSummary: selection.commitJobSummary,
    operations: selection.operations,
    poll: selection.poll,
  });
  const saveReview = useReviewSave({
    records,
    job: selection.job,
    busy: selection.busy,
    currentSection: catalog.currentSection,
    ...selection.operations,
    setNotice,
    refresh: selection.refresh,
    suspendAnalysisPoll: selection.poll.suspendAnalysisPoll,
    resumeAnalysisPoll: selection.poll.resumeAnalysisPoll,
  });
  const jobSectionId = selection.job?.sectionId;
  const activeSectionId = catalog.activeSection;
  const setActiveSection = catalog.setActiveSection;

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

  useEffect(() => {
    if (jobSectionId && jobSectionId !== activeSectionId) {
      setActiveSection(jobSectionId);
    }
  }, [activeSectionId, jobSectionId, setActiveSection]);

  return {
    headerRef,
    headerHeight,
    jobs: selection.jobs,
    job: selection.job,
    recordPage: records.recordPage,
    page: records.page,
    pageSize: records.pageSize,
    selected: records.selected,
    sections: selection.sections,
    platforms: selection.platforms,
    activeFields: catalog.activeFields,
    activeSection: catalog.activeSection,
    setActiveSection: catalog.setActiveSection,
    models: selection.models,
    dialog,
    setDialog,
    filter: records.filter,
    busy: selection.busy,
    notice,
    setNotice,
    knowledgeSection,
    setKnowledgeSection,
    previewImage,
    setPreviewImage,
    taskActionBusy: selection.taskActionBusy,
    ...importWorkflow,
    refreshing: selection.refreshing,
    analysisCapacity,
    setAnalysisCapacity,
    currentSection: catalog.currentSection,
    refresh: selection.refresh,
    navigateToJob: selection.navigateToJob,
    changeRecordPage: records.changeRecordPage,
    changePageSize: records.changePageSize,
    changeFilter: records.changeFilter,
    analyzeRecord: actions.analyzeRecord,
    requestBatchAnalysis: actions.requestBatchAnalysis,
    pendingTargetedCount: actions.pendingTargetedCount,
    targetedSummary: actions.targetedSummary,
    startBatchAnalysis: actions.startBatchAnalysis,
    retryField: actions.retryField,
    saveReview,
    handleJobsDeleted: selection.handleJobsDeleted,
    taskAction: actions.taskAction,
    refreshProgress: selection.refreshProgress,
    requestRecordDetail: records.requestRecordDetail,
    clearSelectedRecord: records.clearSelectedRecord,
    editSelectedRecord: records.editSelectedRecord,
  };
}
