import { useState } from "react";
import type { KnowledgeBase, KnowledgeItem } from "../../../shared/types";
import type { KnowledgeApiClient } from "../../api/knowledge-api";
import { Modal } from "../Modal";

export function KnowledgeItemEditor({
  base,
  item,
  apiClient,
  onClose,
  onSaved,
}: {
  base: KnowledgeBase;
  item: KnowledgeItem | null;
  apiClient: KnowledgeApiClient;
  onClose: () => void;
  onSaved: (item: KnowledgeItem) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(base.columns.map((column) => [column.name, item?.values[column.name] ?? ""])),
  );
  const [isEnabled, setIsEnabled] = useState(item?.isEnabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const saved = item
        ? await apiClient.updateItem(item.id, { values, isEnabled })
        : await apiClient.createItem(base.id, { values, isEnabled });
      onSaved(saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存知识条目失败");
    } finally {
      setBusy(false);
    }
  };

  return <Modal
    title={item ? "编辑知识条目" : "新增知识条目"}
    subtitle={`DYNAMIC COLUMNS / ${base.name}`}
    close={onClose}
    className="knowledge-editor-modal"
  >
    <div className="knowledge-item-editor">
      {base.columns.map((column) => <label key={column.name}>
        <span>{column.name}</span>
        <textarea
          rows={column.roles.includes("description") || column.roles.some((role) => role.includes("example")) ? 3 : 1}
          value={values[column.name] ?? ""}
          onChange={(event) => setValues((current) => ({
            ...current,
            [column.name]: event.target.value,
          }))}
        />
        <small>{column.roles.join(" / ")}</small>
      </label>)}
      <label className="knowledge-toggle">
        <input
          type="checkbox"
          checked={isEnabled}
          onChange={(event) => setIsEnabled(event.target.checked)}
        />
        启用此条目
      </label>
    </div>
    {error && <div className="form-error">{error}</div>}
    <div className="modal-actions">
      <button className="button light" onClick={onClose}>取消</button>
      <button className="button dark" disabled={busy} onClick={save}>
        {busy ? "保存中..." : "保存条目"}
      </button>
    </div>
  </Modal>;
}
