import { useEffect, useRef, useState } from "react";
import type {
  KnowledgeBase,
  KnowledgeColumn,
  KnowledgeColumnRole,
  KnowledgeImportResult,
} from "../../../shared/types";
import type {
  KnowledgeApiClient,
  KnowledgeImportPreviewResponse,
} from "../../api/knowledge-api";
import { Modal } from "../Modal";

const roles: Array<{ value: KnowledgeColumnRole; label: string }> = [
  { value: "result", label: "结果列" },
  { value: "search", label: "搜索列" },
  { value: "keyword", label: "关键词" },
  { value: "description", label: "判定说明" },
  { value: "positive_example", label: "正向案例" },
  { value: "negative_example", label: "反向案例" },
  { value: "metadata", label: "元数据" },
];

function inferRoles(header: string): KnowledgeColumnRole[] {
  if (/说明|描述|判定/.test(header)) return ["description"];
  if (/正向|正确|命中案例/.test(header)) return ["positive_example"];
  if (/反向|错误|排除案例/.test(header)) return ["negative_example"];
  if (/关键词|关键字/.test(header)) return ["keyword", "search"];
  return ["result", "search"];
}

export function KnowledgeImportDialog({
  sectionId,
  targetBase,
  apiClient,
  onClose,
  onImported,
}: {
  sectionId: string;
  targetBase?: KnowledgeBase;
  apiClient: KnowledgeApiClient;
  onClose: () => void;
  onImported: (result: KnowledgeImportResult) => void;
}) {
  const [name, setName] = useState(targetBase?.name ?? "");
  const [preview, setPreview] = useState<KnowledgeImportPreviewResponse | null>(null);
  const [columns, setColumns] = useState<KnowledgeColumn[]>(targetBase?.columns ?? []);
  const [inspecting, setInspecting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const inspectSequence = useRef(0);
  const currentFile = useRef<File | null>(null);
  const inspectingRef = useRef(false);
  const confirmingRef = useRef(false);

  useEffect(() => () => {
    inspectSequence.current += 1;
    currentFile.current = null;
    inspectingRef.current = false;
    confirmingRef.current = false;
  }, []);

  const inspect = async (file: File) => {
    if (confirmingRef.current) return;
    const requestId = ++inspectSequence.current;
    currentFile.current = file;
    inspectingRef.current = true;
    setPreview(null);
    setColumns([]);
    setInspecting(true);
    setError("");
    try {
      const next = await apiClient.previewImport(
        sectionId,
        file,
        targetBase?.columns,
        targetBase?.id,
      );
      if (requestId !== inspectSequence.current || currentFile.current !== file) return;
      setPreview(next);
      const savedByName = new Map(targetBase?.columns.map((column) => [column.name, column]));
      setColumns(next.headers.map((header) => savedByName.get(header) ?? {
        name: header,
        roles: inferRoles(header),
      }));
      if (!name) setName(file.name.replace(/\.xlsx$/i, ""));
    } catch (caught) {
      if (requestId !== inspectSequence.current || currentFile.current !== file) return;
      setError(caught instanceof Error ? caught.message : "知识库预览失败");
    } finally {
      if (requestId === inspectSequence.current && currentFile.current === file) {
        inspectingRef.current = false;
        setInspecting(false);
      }
    }
  };

  const toggleRole = (columnName: string, role: KnowledgeColumnRole) => {
    if (confirmingRef.current) return;
    setColumns((current) => current.map((column) => {
      if (column.name !== columnName) return column;
      const nextRoles = column.roles.includes(role)
        ? column.roles.filter((entry) => entry !== role)
        : [...column.roles, role];
      return { ...column, roles: nextRoles };
    }));
  };

  const confirm = async () => {
    if (confirmingRef.current || inspectingRef.current || !preview) return;
    if (preview.errors.length > 0) {
      setError("预览存在错误，请修正 Excel 后重新预览");
      return;
    }
    if (!columns.some((column) => column.roles.includes("result"))) {
      setError("至少配置一个结果列");
      return;
    }
    confirmingRef.current = true;
    setConfirming(true);
    setError("");
    try {
      const result = await apiClient.confirmImport(
        sectionId,
        preview.token,
        columns,
        name.trim() || undefined,
        targetBase?.id ?? preview.resolvedKnowledgeBaseId ?? undefined,
      );
      onImported(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "知识库导入失败");
    } finally {
      confirmingRef.current = false;
      setConfirming(false);
    }
  };

  const close = () => {
    if (!confirmingRef.current) onClose();
  };

  return <Modal
    title={targetBase ? "重新导入知识库" : "导入知识库"}
    subtitle="EXCEL PREVIEW / COLUMN ROLE MAPPING"
    close={close}
    className={`knowledge-import-modal${confirming ? " confirming" : ""}`}
  >
    <div className="knowledge-import-top">
      <label>
        知识库名称
        <input
          value={name}
          disabled={confirming}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label
        className={`button primary knowledge-file-button${confirming ? " disabled" : ""}`}
        aria-disabled={confirming}
      >
        {confirming ? "正在确认导入..." : inspecting ? "读取中..." : "选择 Excel 文件"}
        <input
          aria-label="选择 Excel 文件"
          hidden
          type="file"
          accept=".xlsx"
          disabled={confirming}
          onChange={(event) => event.target.files?.[0] && inspect(event.target.files[0])}
        />
      </label>
    </div>

    {preview && <>
      <div className="import-metrics">
        <span><b>{preview.totalRows}</b><small>总行数 {preview.totalRows}</small></span>
        <span className="added"><b>{preview.added}</b><small>新增 {preview.added}</small></span>
        <span className="updated"><b>{preview.updated}</b><small>更新 {preview.updated}</small></span>
        <span><b>{preview.skipped}</b><small>跳过 {preview.skipped}</small></span>
        <span className={preview.errors.length ? "errored" : ""}>
          <b>{preview.errors.length}</b><small>错误 {preview.errors.length}</small>
        </span>
      </div>
      <div className="column-map">
        <div className="column-map-head">
          <span>Excel 列</span><span>多角色映射</span><span>父列约束</span>
        </div>
        {columns.map((column) => <div className="column-map-row" key={column.name}>
          <strong>{column.name}</strong>
          <div className="role-options">
            {roles.map((role) => <label key={role.value}>
              <input
                type="checkbox"
                aria-label={`${column.name} ${role.label}`}
                checked={column.roles.includes(role.value)}
                disabled={confirming}
                onChange={() => toggleRole(column.name, role.value)}
              />
              {role.label}
            </label>)}
          </div>
          <select
            aria-label={`${column.name} 父列约束`}
            value={column.requiredParent ?? ""}
            disabled={confirming}
            onChange={(event) => setColumns((current) => current.map((entry) => (
              entry.name === column.name
                ? { ...entry, requiredParent: event.target.value || undefined }
                : entry
            )))}
          >
            <option value="">无父列约束</option>
            {columns.filter((candidate) => candidate.name !== column.name).map((candidate) => (
              <option key={candidate.name} value={candidate.name}>{candidate.name}</option>
            ))}
          </select>
        </div>)}
      </div>
      {preview.errors.length > 0 && <div className="import-errors">
        <strong>预览存在错误，请修正 Excel 后重新预览。确认导入已禁用，不会消耗本次预览令牌。</strong>
        {preview.errors.map((entry) => <p key={`${entry.rowNumber}-${entry.message}`}>
          第 {entry.rowNumber} 行：{entry.message}
        </p>)}
      </div>}
    </>}

    {error && <div className="form-error">{error}</div>}
    <div className="modal-actions">
      <button className="button light" disabled={confirming} onClick={close}>取消</button>
      <button
        className="button dark"
        disabled={!preview || inspecting || confirming || preview.errors.length > 0}
        onClick={confirm}
      >
        {confirming ? "处理中..." : "确认导入"}
      </button>
    </div>
  </Modal>;
}
