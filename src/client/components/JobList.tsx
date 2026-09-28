import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import type {
  AnalysisCapacity,
  AnalysisJobOptions,
  AnalysisSection,
  Job,
} from "../../shared/types";
import type { BatchJobControlResult } from "../../shared/types";
import { api } from "../api";
import { AlertDialog } from "./AlertDialog";
import { AnalysisRunDialog } from "./AnalysisRunDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { formatTokenCount, taskStatusLabels } from "../task-display";

type AnalysisRunOptions = Required<
  Pick<AnalysisJobOptions, "concurrency" | "batchSize" | "maxPaidTokens">
>;

export function JobList({ jobs, sections, sectionFilter, onSectionFilterChange, onOpenKnowledge, selectedId, canDelete = true, canControl = true, onSelect, onDeleted, onBatchControlComplete }: { jobs: Job[]; sections: AnalysisSection[]; sectionFilter?: string; onSectionFilterChange?: (sectionId: string) => void; onOpenKnowledge?: (section: AnalysisSection) => void; selectedId?: string; canDelete?: boolean; canControl?: boolean; onSelect: (id: string) => void; onDeleted: (ids: string[]) => void; onBatchControlComplete?: () => void }) {
  const [pendingDelete, setPendingDelete] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [localSectionId, setLocalSectionId] = useState("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  const [busyControl, setBusyControl] = useState(false);
  const [controlMessage, setControlMessage] = useState("");
  const [controlResults, setControlResults] = useState<Array<{ name: string; result: BatchJobControlResult }>>([]);
  const [resumeCapacity, setResumeCapacity] = useState<AnalysisCapacity | null>(null);
  const remove = (event: MouseEvent, job: Job) => {
    event.stopPropagation();
    setPendingDelete(job);
  };
  const confirmRemove = async () => {
    if (!pendingDelete) return;
    const job = pendingDelete;
    setPendingDelete(null);
    try {
      const response = await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success === false) throw new Error(body.error || "删除任务失败");
      onDeleted([job.id]);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除任务失败");
    }
  };
  const filteredJobs = useMemo(() => jobs.filter((job) => {
    const matchesSearch = !search.trim() || job.originalFilename.toLowerCase().includes(search.trim().toLowerCase());
    const matchesStatus = status === "all" || job.status === status;
    const matchesSection = (sectionFilter ?? localSectionId) === "all" || job.sectionId === (sectionFilter ?? localSectionId);
    return matchesSearch && matchesStatus && matchesSection;
  }), [jobs, search, status, sectionFilter, localSectionId]);
  useEffect(() => {
    const visibleIds = new Set(filteredJobs.map((job) => job.id));
    setSelectedIds((current) => {
      const visible = current.filter((id) => visibleIds.has(id));
      return visible.length === current.length ? current : visible;
    });
  }, [filteredJobs]);
  const childSections = sections.filter((section) => section.parentId);
  const currentSectionFilter = sectionFilter ?? localSectionId;
  const changeSectionFilter = (nextSectionId: string) => {
    setLocalSectionId(nextSectionId);
    onSectionFilterChange?.(nextSectionId);
  };
  const toggleSelected = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const allVisibleSelected = filteredJobs.length > 0 && filteredJobs.every((job) => selectedIds.includes(job.id));
  const toggleAll = () => setSelectedIds(allVisibleSelected ? [] : filteredJobs.map((job) => job.id));
  const selectedJobs = jobs.filter((job) => selectedIds.includes(job.id));
  const processingSelected = selectedJobs.filter((job) => job.status === "processing");
  const pausedSelected = selectedJobs.filter((job) => job.status === "paused");
  const controlJobs = async (action: "pause" | "resume", options?: AnalysisRunOptions) => {
    if (busyControl || !selectedIds.length || selectedIds.length > 50) return;
    setBusyControl(true);
    setControlMessage("");
    setControlResults([]);
    try {
      const results = await api<BatchJobControlResult[]>("/api/jobs/batch-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids: selectedIds, ...options }),
      });
      const names = new Map(jobs.map((job) => [job.id, job.originalFilename]));
      setControlResults(results.map((result) => ({ name: names.get(result.jobId) ?? result.jobId, result })));
      const succeeded = results.filter((result) => result.outcome === "success").length;
      const skipped = results.filter((result) => result.outcome === "skipped").length;
      const failed = results.filter((result) => result.outcome === "failed").length;
      setControlMessage(`${action === "pause" ? "已暂停" : "已开始继续"} ${succeeded} 个，跳过 ${skipped} 个，失败 ${failed} 个`);
      setSelectedIds(results.filter((result) => result.outcome !== "success").map((result) => result.jobId));
      onBatchControlComplete?.();
    } catch (controlError) {
      setControlMessage(controlError instanceof Error ? controlError.message : "批量操作失败");
    } finally {
      setBusyControl(false);
    }
  };
  const requestResume = async () => {
    if (busyControl || !pausedSelected.length || selectedIds.length > 50) return;
    setBusyControl(true);
    setControlMessage("");
    try {
      setResumeCapacity(await api<AnalysisCapacity>("/api/system/analysis-capacity"));
    } catch (controlError) {
      setControlMessage(controlError instanceof Error ? controlError.message : "系统容量指标暂时不可用");
    } finally {
      setBusyControl(false);
    }
  };
  const confirmBulkRemove = async () => {
    if (!selectedIds.length) return;
    try {
      const response = await fetch("/api/jobs", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: selectedIds }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success === false) throw new Error(body.error || "批量删除任务失败");
      const deletedIds = selectedIds;
      setSelectedIds([]);
      setPendingBulkDelete(false);
      onDeleted(deletedIds);
    } catch (bulkDeleteError) {
      setPendingBulkDelete(false);
      setError(bulkDeleteError instanceof Error ? bulkDeleteError.message : "批量删除任务失败");
    }
  };
  const canSelectJobs = canDelete || canControl;
  const renderJob = (job: Job) => <div key={job.id} className={`job ${selectedId === job.id ? "active" : ""}`}>
    {canSelectJobs && <label className="job-check"><input type="checkbox" aria-label={`选择任务 ${job.originalFilename}`} checked={selectedIds.includes(job.id)} disabled={busyControl} onChange={() => toggleSelected(job.id)} onClick={(event) => event.stopPropagation()} /></label>}
    <button className="job-select" onClick={() => onSelect(job.id)}><span className="xls">X</span><span><strong title={job.originalFilename}>{job.originalFilename}</strong><small>{job.sectionName ?? "未指定板块"} · {job.platformName ?? "未指定平台"} · {job.totalRecords} 条记录 · {taskStatusLabels[job.status] ?? job.status}</small><small className="job-usage">消耗 {formatTokenCount(job.usageSummary?.accountedTokens ?? 0)} Tokens · {job.usageSummary?.callCount ?? 0} 次调用{job.usageSummary?.unknownCallCount ? " · 有未知用量" : ""}</small></span></button>
    <span className="job-actions">{canDelete && <button type="button" title="删除任务" onClick={(event) => remove(event, job)}>×</button>}<i>›</i></span>
  </div>;
  const renderSectionGroup = (section: AnalysisSection) => {
    const sectionJobs = filteredJobs.filter((job) => job.sectionId === section.id);
    const totalSectionJobs = jobs.filter((job) => job.sectionId === section.id).length;
    const sectionUsage = jobs
      .filter((job) => job.sectionId === section.id)
      .reduce((summary, job) => ({
        accountedTokens: summary.accountedTokens + (job.usageSummary?.accountedTokens ?? 0),
        callCount: summary.callCount + (job.usageSummary?.callCount ?? 0),
      }), { accountedTokens: 0, callCount: 0 });
    return <div className="job-section-group" data-section-task-group={section.id} key={section.id}>
      <div className="job-section-heading">
        <button type="button" onClick={() => changeSectionFilter(section.id)}><span />{section.name}<b>{totalSectionJobs}</b><i /></button>
        <small className="section-usage">消耗 {formatTokenCount(sectionUsage.accountedTokens)} · {sectionUsage.callCount} 次</small>
        {onOpenKnowledge && <button type="button" className="section-knowledge" aria-label={`打开${section.name}知识库`} title="知识库" onClick={() => onOpenKnowledge(section)}>知</button>}
      </div>
      {sectionJobs.length ? sectionJobs.map(renderJob) : <div className="job-section-empty">当前板块暂无匹配任务</div>}
    </div>;
  };
  const visibleParents = sections.filter((section) => !section.parentId);
  return <><div className="job-filters"><input aria-label="搜索解析任务" placeholder="搜索文件名" value={search} onChange={(event) => setSearch(event.target.value)} /><select aria-label="按任务状态筛选" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option><option value="ready">导入完成，待解析</option><option value="processing">解析中</option><option value="paused">已暂停</option><option value="completed">解析已完成</option><option value="failed">解析失败</option><option value="cancelled">已取消</option></select><select aria-label="按解析板块筛选" value={currentSectionFilter} onChange={(event) => changeSectionFilter(event.target.value)}><option value="all">全部板块</option>{childSections.map((section) => <option value={section.id} key={section.id}>{section.name}</option>)}</select></div>{canSelectJobs && <div className="job-bulk-bar"><label><input type="checkbox" aria-label="全选当前任务" checked={allVisibleSelected} disabled={busyControl} onChange={toggleAll} />全选当前任务</label><span>{selectedIds.length ? `已选择 ${selectedIds.length} 个任务` : "未选择任务"}</span>{canDelete && <button type="button" disabled={!selectedIds.length || busyControl} onClick={() => setPendingBulkDelete(true)}>批量删除</button>}</div>}
  {canControl && selectedIds.length > 0 && <div className="job-control-bar">
    {processingSelected.length > 0 && <button type="button" disabled={busyControl || selectedIds.length > 50} onClick={() => void controlJobs("pause")}>批量暂停 {processingSelected.length} 个{processingSelected.length < selectedJobs.length ? `（其余 ${selectedJobs.length - processingSelected.length} 个将跳过）` : ""}</button>}
    {pausedSelected.length > 0 && <button type="button" disabled={busyControl || selectedIds.length > 50} onClick={() => void requestResume()}>批量继续 {pausedSelected.length} 个{pausedSelected.length < selectedJobs.length ? `（其余 ${selectedJobs.length - pausedSelected.length} 个将跳过）` : ""}</button>}
    {selectedIds.length > 50 && <span role="status">批量暂停或继续一次最多选择 50 个任务</span>}
    {busyControl && <span role="status">正在处理所选任务...</span>}
  </div>}
  {controlMessage && <div className="job-control-results" role="status"><strong>{controlMessage}</strong>{controlResults.map(({ name, result }) => <span key={result.jobId}>{name}：{result.outcome === "success" ? (result.status === "paused" ? "已暂停" : "已开始继续") : result.reason}</span>)}</div>}
  <div className="job-section-groups">{visibleParents.length ? visibleParents.map((parent) => {
    const children = childSections.filter((section) => section.parentId === parent.id)
      .filter((section) => currentSectionFilter === "all" || section.id === currentSectionFilter);
    return <div className="job-section-parent" key={parent.id}><div className="job-section-parent-label">╰ {parent.name}</div>{children.map(renderSectionGroup)}</div>;
  }) : childSections
    .filter((section) => currentSectionFilter === "all" || section.id === currentSectionFilter)
    .map(renderSectionGroup)}</div>
  {!filteredJobs.length && <div className="job-filter-empty">没有匹配的解析任务</div>}{pendingDelete && <ConfirmDialog title="删除解析任务" message={`确认删除“${pendingDelete.originalFilename}”吗？原始 Excel、截图和解析结果都会一并删除。`} onConfirm={confirmRemove} onCancel={() => setPendingDelete(null)} />}{pendingBulkDelete && <ConfirmDialog title="批量删除解析任务" message={`确认删除已选择的 ${selectedIds.length} 个任务吗？原始 Excel、截图和解析结果都会一并删除。`} onConfirm={confirmBulkRemove} onCancel={() => setPendingBulkDelete(false)} />}{resumeCapacity && <AnalysisRunDialog capacity={resumeCapacity} onCancel={() => setResumeCapacity(null)} onConfirm={(options) => { setResumeCapacity(null); void controlJobs("resume", options); }} />}{error && <AlertDialog title="删除任务失败" message={error} close={() => setError("")} />}</>;
}
