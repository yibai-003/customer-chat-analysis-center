import { useEffect, useRef, useState } from "react";
import type { KnowledgeBase } from "../../../shared/types";
import type { KnowledgeApiClient } from "../../api/knowledge-api";
import { ConfirmDialog } from "../ConfirmDialog";

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { hour12: false });
}

export function KnowledgeBaseList({
  sectionId,
  bases,
  selectedId,
  apiClient,
  onSelect,
  onImport,
  onReimport,
  onChanged,
}: {
  sectionId: string;
  bases: KnowledgeBase[];
  selectedId?: string;
  apiClient: KnowledgeApiClient;
  onSelect: (base: KnowledgeBase) => void;
  onImport: () => void;
  onReimport: (base: KnowledgeBase) => void;
  onChanged: () => void | Promise<void>;
}) {
  const [pendingDelete, setPendingDelete] = useState<KnowledgeBase | null>(null);
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const sectionIdRef = useRef(sectionId);
  const mutationSequence = useRef(0);
  sectionIdRef.current = sectionId;

  useEffect(() => {
    mutationSequence.current += 1;
    setBusyAction(null);
    setPendingDelete(null);
    setError("");
  }, [sectionId]);

  const toggle = async (base: KnowledgeBase) => {
    if (busyAction) return;
    const requestId = ++mutationSequence.current;
    const requestedSectionId = sectionId;
    setBusyAction(`toggle:${base.id}`);
    setError("");
    try {
      await apiClient.updateBase(base.id, { isEnabled: !base.isEnabled });
      if (requestId !== mutationSequence.current || sectionIdRef.current !== requestedSectionId) return;
      await onChanged();
    } catch (caught) {
      if (requestId !== mutationSequence.current || sectionIdRef.current !== requestedSectionId) return;
      setError(caught instanceof Error ? caught.message : "更新知识库状态失败");
    } finally {
      if (requestId === mutationSequence.current && sectionIdRef.current === requestedSectionId) {
        setBusyAction(null);
      }
    }
  };

  const remove = async () => {
    if (!pendingDelete || busyAction) return;
    const target = pendingDelete;
    const requestId = ++mutationSequence.current;
    const requestedSectionId = sectionId;
    setPendingDelete(null);
    setBusyAction(`delete:${target.id}`);
    setError("");
    try {
      await apiClient.deleteBase(target.id);
      if (requestId !== mutationSequence.current || sectionIdRef.current !== requestedSectionId) return;
      await onChanged();
    } catch (caught) {
      if (requestId !== mutationSequence.current || sectionIdRef.current !== requestedSectionId) return;
      setError(caught instanceof Error ? caught.message : "删除知识库失败");
    } finally {
      if (requestId === mutationSequence.current && sectionIdRef.current === requestedSectionId) {
        setBusyAction(null);
      }
    }
  };

  return <div className="knowledge-base-view">
    <div className="knowledge-band-head">
      <div><small>CONTENT MANAGEMENT</small><h2>知识库文件</h2></div>
      <button className="button primary" disabled={Boolean(busyAction)} onClick={onImport}>＋ 导入知识库</button>
    </div>
    {!bases.length ? <div className="knowledge-empty">
      <b>XLSX</b><h3>当前板块还没有知识库</h3>
      <p>导入 Excel 后配置动态列角色与父列校验关系。</p>
      <button className="button primary" disabled={Boolean(busyAction)} onClick={onImport}>导入知识库</button>
    </div> : <div className="knowledge-table-scroll">
      <div className="knowledge-base-table">
        <div className="knowledge-base-row head">
          <span>知识库</span><span>动态列</span><span>条目</span><span>状态</span><span>更新时间</span><span>操作</span>
        </div>
        {bases.map((base) => <div
          key={base.id}
          className={`knowledge-base-row ${selectedId === base.id ? "selected" : ""}`}
        >
          <button className="knowledge-base-name" onClick={() => onSelect(base)}>
            <b>X</b><span><strong>{base.name}</strong><small>{base.originalFilename}</small></span>
          </button>
          <span>{base.columns.length} 列</span>
          <span>{base.itemCount}</span>
          <span className={`knowledge-state ${base.isEnabled ? "enabled" : "disabled"}`}>
            {base.isEnabled ? "已启用" : "已停用"}
          </span>
          <time>{formatTime(base.updatedAt)}</time>
          <span className="knowledge-row-actions">
            <button disabled={Boolean(busyAction)} onClick={() => onReimport(base)}>重新导入</button>
            <button disabled={Boolean(busyAction)} onClick={() => toggle(base)}>{base.isEnabled ? "停用" : "启用"}</button>
            <button disabled={Boolean(busyAction)} className="danger-text" onClick={() => setPendingDelete(base)}>删除</button>
          </span>
        </div>)}
      </div>
    </div>}
    {error && <div className="form-error">{error}</div>}
    {pendingDelete && <ConfirmDialog
      title="删除知识库"
      message={`确认删除“${pendingDelete.name}”吗？其中的 ${pendingDelete.itemCount} 条知识条目也会删除，删除后无法恢复。`}
      onConfirm={remove}
      onCancel={() => setPendingDelete(null)}
    />}
  </div>;
}
