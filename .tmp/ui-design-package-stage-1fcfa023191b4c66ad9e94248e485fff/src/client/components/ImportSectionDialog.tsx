import { useState } from "react";
import type { AnalysisSection } from "../../shared/types";
import { Modal } from "./Modal";

export function ImportSectionDialog({ file, sections, busy, error, onConfirm, onCancel }: {
  file: File; sections: AnalysisSection[]; busy: boolean;
  error?: string;
  onConfirm: (sectionId: string) => void; onCancel: () => void;
}) {
  const [sectionId, setSectionId] = useState("");
  const available = sections.filter((section) => section.parentId && section.isEnabled);
  return <Modal title="选择文件所属板块" subtitle="本次选择将绑定到新任务，不受当前查看的任务影响" close={() => { if (!busy) onCancel(); }}>
    <div className="import-preview-summary"><strong>{file.name}</strong></div>
    <div className="form-grid import-section-form"><label className="wide">解析板块
      <select aria-label="文件所属解析板块" value={sectionId} disabled={busy} onChange={(event) => setSectionId(event.target.value)}>
        <option value="">请选择解析板块</option>
        {available.map((section) => <option key={section.id} value={section.id}>{sections.find((parent) => parent.id === section.parentId)?.name} / {section.name}</option>)}
      </select>
    </label></div>
    {!available.length && <p role="status">暂无已启用的子板块，请先在板块配置中添加。</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="modal-actions"><button className="button light" disabled={busy} onClick={onCancel}>取消</button><button className="button dark" disabled={busy || !available.some((section) => section.id === sectionId)} onClick={() => onConfirm(sectionId)}>{busy ? "读取预览中..." : "下一步：预览文件"}</button></div>
  </Modal>;
}
