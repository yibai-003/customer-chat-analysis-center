import { useCallback, useEffect, useRef, useState } from "react";
import type { AuditEvent, AuditEventPage } from "../../../shared/types";
import { api } from "../../api";
import { Modal } from "../Modal";

interface FilterDraft {
  action: string;
  actorUserId: string;
  targetType: string;
  targetId: string;
  outcome: "" | "success" | "failure";
  from: string;
  to: string;
}

const EMPTY_FILTERS: FilterDraft = {
  action: "",
  actorUserId: "",
  targetType: "",
  targetId: "",
  outcome: "",
  from: "",
  to: "",
};

function toIso(value: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function buildQuery(filters: FilterDraft, cursor?: string | null) {
  const params = new URLSearchParams();
  if (filters.action.trim()) params.set("action", filters.action.trim());
  if (filters.actorUserId.trim()) params.set("actorUserId", filters.actorUserId.trim());
  if (filters.targetType.trim()) params.set("targetType", filters.targetType.trim());
  if (filters.targetId.trim()) params.set("targetId", filters.targetId.trim());
  if (filters.outcome) params.set("outcome", filters.outcome);
  const from = toIso(filters.from);
  if (from) params.set("from", from);
  const to = toIso(filters.to);
  if (to) params.set("to", to);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", "25");
  return params.toString();
}

function formatTime(value: string) {
  return value.replace("T", " ").slice(0, 19);
}

export function AuditLogDialog({ close }: { close: () => void }) {
  const mounted = useRef(true);
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<FilterDraft>(EMPTY_FILTERS);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async (filters: FilterDraft, cursor?: string | null) => {
    setLoading(true);
    setError("");
    try {
      const page = await api<AuditEventPage>(`/api/admin/audit-events?${buildQuery(filters, cursor)}`);
      if (!mounted.current) return;
      setEvents((current) => cursor ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      if (mounted.current) setError(loadError instanceof Error ? loadError.message : "审计事件加载失败");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(EMPTY_FILTERS, null);
  }, [load]);

  const applyFilters = () => {
    const next = { ...draft };
    setApplied(next);
    void load(next, null);
  };

  const resetFilters = () => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    void load(EMPTY_FILTERS, null);
  };

  return <Modal title="审计日志" subtitle="PIXEL OPERATIONS / AUDIT TRAIL" close={close} className="audit-log-modal">
    <div className="audit-filters">
      <label>动作<input aria-label="按动作筛选" value={draft.action} placeholder="如 task.export" onChange={(event) => setDraft({ ...draft, action: event.target.value })} /></label>
      <label>操作者 ID<input aria-label="按操作者筛选" value={draft.actorUserId} onChange={(event) => setDraft({ ...draft, actorUserId: event.target.value })} /></label>
      <label>目标类型<input aria-label="按目标类型筛选" value={draft.targetType} onChange={(event) => setDraft({ ...draft, targetType: event.target.value })} /></label>
      <label>目标 ID<input aria-label="按目标ID筛选" value={draft.targetId} onChange={(event) => setDraft({ ...draft, targetId: event.target.value })} /></label>
      <label>结果<select aria-label="按结果筛选" value={draft.outcome} onChange={(event) => setDraft({ ...draft, outcome: event.target.value as FilterDraft["outcome"] })}>
        <option value="">全部</option>
        <option value="success">成功</option>
        <option value="failure">拒绝或失败</option>
      </select></label>
      <label>开始时间<input type="datetime-local" aria-label="开始时间" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
      <label>结束时间<input type="datetime-local" aria-label="结束时间" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
      <div className="audit-filter-actions">
        <button type="button" className="button light" disabled={loading} onClick={resetFilters}>重置</button>
        <button type="button" className="button dark" disabled={loading} onClick={applyFilters}>{loading ? "查询中…" : "查询"}</button>
      </div>
    </div>

    {error && <div className="form-error" role="alert">{error}</div>}

    <div className="audit-event-list">
      {events.map((event) => <article className="audit-event" key={event.id}>
        <header>
          <time>{formatTime(event.occurredAt)}</time>
          <strong>{event.actorDisplay}</strong>
          <code>{event.action}</code>
          <span className={`audit-outcome ${event.outcome}`}>{event.outcome === "success" ? "成功" : "拒绝/失败"}</span>
        </header>
        <p className="audit-target">
          目标：{event.targetType ?? "无"}{event.targetId ? ` / ${event.targetId}` : ""}
        </p>
        <p className="audit-correlation">请求 ID：<code>{event.correlationId ?? "未记录"}</code></p>
        <details>
          <summary>安全元数据</summary>
          <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
        </details>
      </article>)}
      {!events.length && !loading && !error && <p className="audit-empty">当前筛选条件下没有审计事件</p>}
    </div>

    <div className="modal-actions">
      <span className="audit-count">已加载 {events.length} 条</span>
      <button type="button" className="button light" disabled={!nextCursor || loading} onClick={() => void load(applied, nextCursor)}>
        {loading && nextCursor ? "加载中…" : "加载更多（更早事件）"}
      </button>
    </div>
    <p className="audit-note">审计事件为追加写入，不可修改或删除；详情仅展示安全元数据。</p>
  </Modal>;
}