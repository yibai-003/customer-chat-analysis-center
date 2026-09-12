import { useEffect, useRef, useState } from "react";
import type { KnowledgeBase, KnowledgeItem, KnowledgeItemPage } from "../../../shared/types";
import type { KnowledgeApiClient } from "../../api/knowledge-api";
import { ConfirmDialog } from "../ConfirmDialog";
import { KnowledgeItemEditor } from "./KnowledgeItemEditor";

type EnabledFilter = "all" | "true" | "false";

interface ItemLoadRequest {
  baseId: string;
  search: string;
  enabled: EnabledFilter;
  page: number;
}

const emptyPage: KnowledgeItemPage = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 25,
};

export function KnowledgeItemList({
  base,
  apiClient,
  onBaseCountChanged,
}: {
  base: KnowledgeBase;
  apiClient: KnowledgeApiClient;
  onBaseCountChanged: () => void;
}) {
  const [page, setPage] = useState<KnowledgeItemPage>(emptyPage);
  const [search, setSearch] = useState("");
  const [enabled, setEnabled] = useState<EnabledFilter>("all");
  const [pageNumber, setPageNumber] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<KnowledgeItem | null | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<KnowledgeItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);
  const mutationSequence = useRef(0);
  const baseIdRef = useRef(base.id);
  const requestRef = useRef<ItemLoadRequest>({
    baseId: base.id,
    search,
    enabled,
    page: pageNumber,
  });
  baseIdRef.current = base.id;
  requestRef.current = { baseId: base.id, search, enabled, page: pageNumber };

  const load = async (request: ItemLoadRequest = requestRef.current): Promise<boolean> => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError("");
    try {
      const next = await apiClient.listItems(request.baseId, {
        search: request.search.trim() || undefined,
        enabled: request.enabled === "all" ? undefined : request.enabled === "true",
        page: request.page,
        pageSize: 25,
      });
      if (requestId !== requestSequence.current || baseIdRef.current !== request.baseId) {
        return false;
      }
      const nextTotalPages = Math.max(1, Math.ceil(next.total / next.pageSize));
      if (request.page > nextTotalPages) {
        setPageNumber(nextTotalPages);
        return true;
      }
      setPage(next);
      return true;
    } catch (caught) {
      if (requestId !== requestSequence.current || baseIdRef.current !== request.baseId) {
        return false;
      }
      setError(caught instanceof Error ? caught.message : "加载知识条目失败");
      return false;
    } finally {
      if (requestId === requestSequence.current && baseIdRef.current === request.baseId) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    requestSequence.current += 1;
    mutationSequence.current += 1;
    setPage(emptyPage);
    setPageNumber(1);
    setSelectedIds([]);
    setEditing(undefined);
    setPendingDelete(null);
    setBusyAction(null);
    setError("");
  }, [base.id]);

  useEffect(() => {
    void load({ baseId: base.id, search, enabled, page: pageNumber });
  }, [base.id, search, enabled, pageNumber]);

  useEffect(() => () => {
    requestSequence.current += 1;
    mutationSequence.current += 1;
  }, []);

  const toggleSelected = (id: string) => {
    if (busyAction) return;
    setSelectedIds((current) => current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id]);
  };

  const runMutation = async (
    actionKey: string,
    operation: () => Promise<void>,
    failureMessage: string,
    afterSuccess?: () => Promise<void>,
  ): Promise<boolean> => {
    if (busyAction) return false;
    const mutationId = ++mutationSequence.current;
    const requestedBaseId = base.id;
    setBusyAction(actionKey);
    setError("");
    try {
      await operation();
      if (mutationId !== mutationSequence.current || baseIdRef.current !== requestedBaseId) {
        return false;
      }
      await afterSuccess?.();
      return mutationId === mutationSequence.current && baseIdRef.current === requestedBaseId;
    } catch (caught) {
      if (mutationId === mutationSequence.current && baseIdRef.current === requestedBaseId) {
        setError(caught instanceof Error ? caught.message : failureMessage);
      }
      return false;
    } finally {
      if (mutationId === mutationSequence.current && baseIdRef.current === requestedBaseId) {
        setBusyAction(null);
      }
    }
  };

  const toggleItem = async (item: KnowledgeItem) => {
    await runMutation(
      `toggle:${item.id}`,
      async () => { await apiClient.updateItem(item.id, { isEnabled: !item.isEnabled }); },
      "更新知识条目状态失败",
      async () => { await load(requestRef.current); },
    );
  };

  const batchSetEnabled = async (isEnabled: boolean) => {
    if (busyAction || !selectedIds.length) return;
    const ids = [...selectedIds];
    const mutationId = ++mutationSequence.current;
    const requestedBaseId = base.id;
    setBusyAction(`batch:${isEnabled}`);
    setError("");
    try {
      const results = await Promise.allSettled(
        ids.map((id) => apiClient.updateItem(id, { isEnabled })),
      );
      if (mutationId !== mutationSequence.current || baseIdRef.current !== requestedBaseId) return;
      const failedIds = ids.filter((_id, index) => results[index].status === "rejected");
      setSelectedIds(failedIds);
      await load(requestRef.current);
      if (failedIds.length) {
        setError(`批量更新部分失败（${failedIds.length}/${ids.length}），列表已刷新，请重试失败项`);
      }
    } catch (caught) {
      if (mutationId !== mutationSequence.current || baseIdRef.current !== requestedBaseId) return;
      await load(requestRef.current);
      setError(caught instanceof Error ? caught.message : "批量更新失败，列表已刷新");
    } finally {
      if (mutationId === mutationSequence.current && baseIdRef.current === requestedBaseId) {
        setBusyAction(null);
      }
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete || busyAction) return;
    const target = pendingDelete;
    setPendingDelete(null);
    await runMutation(
      `delete:${target.id}`,
      async () => { await apiClient.deleteItem(target.id); },
      "删除知识条目失败",
      async () => {
        await load(requestRef.current);
        if (baseIdRef.current === base.id) onBaseCountChanged();
      },
    );
  };

  const totalPages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const mutationsLocked = Boolean(busyAction);

  return <div className="knowledge-items-view">
    <div className="knowledge-sticky-actions">
      <div>
        <small>ACTIVE BASE</small>
        <strong>{base.name}</strong>
        <span>{page.total} 条</span>
      </div>
      <div className="knowledge-item-tools">
        <input
          aria-label="搜索知识条目"
          placeholder="搜索动态列内容"
          value={search}
          disabled={mutationsLocked}
          onChange={(event) => { setSearch(event.target.value); setPageNumber(1); }}
        />
        <select
          aria-label="知识条目状态筛选"
          value={enabled}
          disabled={mutationsLocked}
          onChange={(event) => {
            setEnabled(event.target.value as EnabledFilter);
            setPageNumber(1);
          }}
        >
          <option value="all">全部状态</option>
          <option value="true">已启用</option>
          <option value="false">已停用</option>
        </select>
        <button
          className="button primary"
          disabled={mutationsLocked}
          onClick={() => setEditing(null)}
        >＋ 新增条目</button>
      </div>
    </div>

    {selectedIds.length > 0 && <div className="knowledge-batch-bar">
      已选择 {selectedIds.length} 条
      <button disabled={mutationsLocked} onClick={() => batchSetEnabled(true)}>批量启用</button>
      <button disabled={mutationsLocked} onClick={() => batchSetEnabled(false)}>批量停用</button>
      <button disabled={mutationsLocked} onClick={() => setSelectedIds([])}>取消选择</button>
    </div>}

    {error && <div className="form-error">{error}</div>}
    {loading ? <div className="knowledge-loading">正在读取知识条目...</div> : !page.items.length
      ? <div className="knowledge-empty compact"><h3>没有匹配的知识条目</h3></div>
      : <div className="knowledge-table-scroll">
        <table className="knowledge-item-table">
          <thead><tr>
            <th><input
              aria-label="选择当前页全部条目"
              type="checkbox"
              disabled={mutationsLocked}
              checked={page.items.length > 0 && page.items.every((entry) => selectedIds.includes(entry.id))}
              onChange={(event) => setSelectedIds(event.target.checked ? page.items.map((entry) => entry.id) : [])}
            /></th>
            {base.columns.map((column) => <th key={column.name}>{column.name}</th>)}
            {base.sectionId === "hot-topic" && <th title="按当前关联的不同记录计数；同一记录重试不重复计数">关联记录数</th>}
            <th>状态</th><th>来源行</th><th>操作</th>
          </tr></thead>
          <tbody>{page.items.map((item) => <tr
            key={item.id}
            data-testid={`knowledge-item-${item.id}`}
            className={item.isEnabled ? "" : "disabled"}
          >
            <td><input
              aria-label={`选择知识条目 ${item.id}`}
              type="checkbox"
              disabled={mutationsLocked}
              checked={selectedIds.includes(item.id)}
              onChange={() => toggleSelected(item.id)}
            /></td>
            {base.columns.map((column) => <td key={column.name}>{item.values[column.name] || "空"}</td>)}
            {base.sectionId === "hot-topic" && <td>{item.occurrenceCount ?? 0}</td>}
            <td><span className={`knowledge-state ${item.isEnabled ? "enabled" : "disabled"}`}>
              {item.isEnabled ? "已启用" : "已停用"}
            </span></td>
            <td>{item.sourceRowNumber ?? (base.originalFilename === "AI 自动补充" ? "自动补充库" : "手工")}</td>
            <td><span className="knowledge-row-actions">
              <button disabled={mutationsLocked} aria-label="编辑知识条目" onClick={() => setEditing(item)}>编辑</button>
              <button disabled={mutationsLocked} onClick={() => toggleItem(item)}>{item.isEnabled ? "停用" : "启用"}</button>
              <button
                disabled={mutationsLocked}
                aria-label="删除知识条目"
                className="danger-text"
                onClick={() => setPendingDelete(item)}
              >删除</button>
            </span></td>
          </tr>)}</tbody>
        </table>
      </div>}

    <div className="knowledge-pagination">
      <button
        disabled={mutationsLocked || pageNumber <= 1}
        onClick={() => setPageNumber((value) => value - 1)}
      >上一页</button>
      <span>{pageNumber} / {totalPages}</span>
      <button
        disabled={mutationsLocked || pageNumber >= totalPages}
        onClick={() => setPageNumber((value) => value + 1)}
      >下一页</button>
    </div>

    {editing !== undefined && <KnowledgeItemEditor
      base={base}
      item={editing}
      apiClient={apiClient}
      onClose={() => setEditing(undefined)}
      onSaved={async () => {
        if (baseIdRef.current !== base.id) return;
        setEditing(undefined);
        await load(requestRef.current);
        if (baseIdRef.current === base.id) onBaseCountChanged();
      }}
    />}
    {pendingDelete && <ConfirmDialog
      title="删除知识条目"
      message="确认删除这条知识条目吗？删除后无法恢复，并会立即从本地检索结果中移除。"
      onConfirm={confirmDelete}
      onCancel={() => setPendingDelete(null)}
    />}
  </div>;
}
