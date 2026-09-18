import { useMemo, useState } from "react";
import type { MouseEvent } from "react";
import type { AnalysisSection, Job } from "../../shared/types";
import { AlertDialog } from "./AlertDialog";
import { ConfirmDialog } from "./ConfirmDialog";

const labels: Record<string, string> = { ready: "待解析", processing: "解析中", paused: "已暂停", completed: "已完成", failed: "失败", cancelled: "已取消" };

export function JobList({ jobs, sections, selectedId, canDelete = true, onSelect, onDeleted }: { jobs: Job[]; sections: AnalysisSection[]; selectedId?: string; canDelete?: boolean; onSelect: (id: string) => void; onDeleted: (ids: string[]) => void }) {
  const [pendingDelete, setPendingDelete] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [sectionId, setSectionId] = useState("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
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
    } catch (error) {
      setError(error instanceof Error ? error.message : "删除任务失败");
    }
  };
  const filteredJobs = useMemo(() => jobs.filter((job) => {
    const matchesSearch = !search.trim() || job.originalFilename.toLowerCase().includes(search.trim().toLowerCase());
    const matchesStatus = status === "all" || job.status === status;
    const matchesSection = sectionId === "all" || job.sectionId === sectionId;
    return matchesSearch && matchesStatus && matchesSection;
  }), [jobs, search, status, sectionId]);
  const childSections = sections.filter((section) => section.parentId);
  const toggleSelected = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const allVisibleSelected = filteredJobs.length > 0 && filteredJobs.every((job) => selectedIds.includes(job.id));
  const toggleAll = () => setSelectedIds(allVisibleSelected ? [] : filteredJobs.map((job) => job.id));
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
    } catch (error) {
      setPendingBulkDelete(false);
      setError(error instanceof Error ? error.message : "批量删除任务失败");
    }
  };
  return <><div className="job-filters"><input aria-label="搜索解析任务" placeholder="搜索文件名" value={search} onChange={(event) => setSearch(event.target.value)} /><select aria-label="按任务状态筛选" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option><option value="ready">待解析</option><option value="processing">解析中</option><option value="paused">已暂停</option><option value="completed">已完成</option><option value="failed">失败</option><option value="cancelled">已取消</option></select><select aria-label="按解析板块筛选" value={sectionId} onChange={(event) => setSectionId(event.target.value)}><option value="all">全部板块</option>{childSections.map((section) => <option value={section.id} key={section.id}>{section.name}</option>)}</select></div>{canDelete && <div className="job-bulk-bar"><label><input type="checkbox" aria-label="全选当前任务" checked={allVisibleSelected} onChange={toggleAll} />全选当前任务</label><span>{selectedIds.length ? `已选择 ${selectedIds.length} 个任务` : "未选择任务"}</span><button type="button" disabled={!selectedIds.length} onClick={() => setPendingBulkDelete(true)}>批量删除</button></div>}{filteredJobs.map((job) => <div key={job.id} className={`job ${selectedId === job.id ? "active" : ""}`}>
    {canDelete && <label className="job-check"><input type="checkbox" aria-label={`选择任务 ${job.originalFilename}`} checked={selectedIds.includes(job.id)} onChange={() => toggleSelected(job.id)} onClick={(event) => event.stopPropagation()} /></label>}<button className="job-select" onClick={() => onSelect(job.id)}><span className="xls">X</span><span><strong>{job.originalFilename}</strong><small>{job.sectionName ?? "未指定板块"} · {job.totalRecords} 条记录 · {labels[job.status] ?? job.status}</small></span></button>
    <span className="job-actions">{canDelete && <button type="button" title="删除任务" onClick={(event) => remove(event, job)}>×</button>}<i>›</i></span>
  </div>)}{!filteredJobs.length && <div className="job-filter-empty">没有匹配的解析任务</div>}{pendingDelete && <ConfirmDialog title="删除解析任务" message={`确认删除“${pendingDelete.originalFilename}”吗？原始 Excel、截图和解析结果都会一并删除。`} onConfirm={confirmRemove} onCancel={() => setPendingDelete(null)} />}{pendingBulkDelete && <ConfirmDialog title="批量删除解析任务" message={`确认删除已选择的 ${selectedIds.length} 个任务吗？原始 Excel、截图和解析结果都会一并删除。`} onConfirm={confirmBulkRemove} onCancel={() => setPendingBulkDelete(false)} />}{error && <AlertDialog title="删除任务失败" message={error} close={() => setError("")} />}</>;
}
