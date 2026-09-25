import { useEffect, useRef, useState, type RefObject } from "react";
import type { ImportJob, Platform, WorkbookPreview } from "../../shared/types";
import type { JobOperationToken } from "./workspace-types";
import { api } from "../api";
interface ImportOptions { captureJobOperation: () => JobOperationToken; startBusyOperation: (token: JobOperationToken) => void; finishBusyOperation: (token: JobOperationToken) => void; isJobOperationCurrent: (token: JobOperationToken) => boolean; setNotice: (message: string) => void; refresh: (jobId?: string) => Promise<boolean>; activeJobIdRef: RefObject<string | null>; pendingNavigationRef: RefObject<unknown>; platforms: Platform[] }
export function useImportWorkflow(options: ImportOptions) {
  const previewAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => previewAbortRef.current?.abort(), []);
  const { captureJobOperation, startBusyOperation, finishBusyOperation, isJobOperationCurrent, setNotice, refresh, activeJobIdRef, pendingNavigationRef } = options;
  const [importPreview, setImportPreview] = useState<WorkbookPreview | null>(null);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [selectingImportFile, setSelectingImportFile] = useState<File | null>(null);
  const [importJobId, setImportJobId] = useState<string | null>(null);
  const pendingImportOriginRef = useRef<JobOperationToken | null>(null);
  const commitImport = async (file: File, sectionId: string, platformId: string) => {
    const operation = captureJobOperation();
    startBusyOperation(operation); setNotice("");
    try {
      const form = new FormData(); form.append("file", file);
      form.append("sectionId", sectionId);
      form.append("platformId", platformId);
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
  const importFile = (file: File) => {
    previewAbortRef.current?.abort();
    setNotice("");
    setImportPreview(null);
    setPendingImportFile(null);
    setSelectingImportFile(file);
  };
  const previewImport = async (file: File, sectionId: string, platformId: string) => {
    previewAbortRef.current?.abort();
    const request = new AbortController(); previewAbortRef.current = request;
    const operation = captureJobOperation();
    startBusyOperation(operation); setNotice("");
    try {
      const form = new FormData(); form.append("file", file);
      form.append("sectionId", sectionId);
      form.append("platformId", platformId);
      const preview = await api<WorkbookPreview>("/api/jobs/import-preview", { method: "POST", body: form, signal: request.signal });
      if (request.signal.aborted || !isJobOperationCurrent(operation)) return;
      setSelectingImportFile(null);
      setPendingImportFile(file); setImportPreview({ ...preview, sectionId, platformId });
    } catch (error) {
      if (isJobOperationCurrent(operation)) {
        if (!request.signal.aborted) setNotice(error instanceof Error ? error.message : "读取 Excel 失败");
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

  return {
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
  };
}
