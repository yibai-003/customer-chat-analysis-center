import { useEffect, useState } from "react";
import { MarkdownPreview } from "./MarkdownPreview";
import { Modal } from "./Modal";

export function PromptEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!open) setDraft(value);
  }, [open, value]);

  const closeEditor = () => {
    setDraft(value);
    setOpen(false);
  };

  return <>
    <div className="prompt-field">
      <div className="prompt-field-head">
        <span>字段提示词</span>
        <button type="button" className="prompt-expand" onClick={() => { setDraft(value); setOpen(true); setMode("edit"); }}>↗ 展开编辑</button>
      </div>
      <textarea aria-label="字段提示词" rows={3} value={value} onChange={(event) => onChange(event.target.value)} />
      <small>支持 Markdown：标题、列表、加粗和代码片段</small>
    </div>
    {open && <Modal className="prompt-modal" title="字段提示词" subtitle="MARKDOWN / FIELD PROMPT" close={closeEditor}>
      <div className="prompt-workbench">
        <div className="prompt-mode-switch" role="tablist" aria-label="提示词视图">
          <button type="button" className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>编辑</button>
          <button type="button" className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>预览</button>
        </div>
        {mode === "edit"
          ? <textarea className="prompt-large-editor" aria-label="Markdown 提示词编辑器" value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus />
          : <MarkdownPreview value={draft} />}
      </div>
      <div className="modal-actions">
        <button type="button" className="button light" onClick={closeEditor}>取消</button>
        <button type="button" className="button dark" onClick={() => { onChange(draft); setOpen(false); }}>保存提示词 →</button>
      </div>
    </Modal>}
  </>;
}
