import type { WorkbookPreview } from "../../shared/types";
import { Modal } from "./Modal";

export function ImportPreviewDialog({
  preview,
  onConfirm,
  onCancel,
  busy,
}: {
  preview: WorkbookPreview;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return <Modal title="确认导入 Excel" subtitle="导入前检查工作表、表头和嵌入图片" close={onCancel}>
    <div className="import-preview-summary"><strong>{preview.originalFilename}</strong><span>{preview.sheetCount} 个工作表</span><span>{preview.imageCount} 张嵌入图片</span></div>
    <div className="import-preview-sheets">{preview.sheets.map((sheet) => <div className="import-preview-sheet" key={sheet.name}><div><strong>{sheet.name}</strong><small>{sheet.imageCount} 张图片{sheet.imageRows.length ? ` · 图片行 ${sheet.imageRows.slice(0, 8).join(", ")}${sheet.imageRows.length > 8 ? "…" : ""}` : ""}</small></div><p>{sheet.headers.length ? sheet.headers.join(" · ") : "未识别到表头"}</p></div>)}</div>
    {preview.sectionName && <div className="import-preview-section">当前解析板块：<strong>{preview.sectionName}</strong></div>}
    {preview.missingHeaders.length > 0 && <div className="import-errors"><strong>缺少必需表头</strong><p>{preview.missingHeaders.join("、")}</p></div>}
    {!preview.imageCount && <div className="notice">未识别到嵌入图片，确认导入后仍会被拒绝。</div>}
    <div className="modal-actions"><button className="button light" onClick={onCancel} disabled={busy}>返回选择板块</button><button className="button dark" onClick={onConfirm} disabled={busy || !preview.imageCount || preview.missingHeaders.length > 0}>{busy ? "导入中..." : "确认导入 →"}</button></div>
  </Modal>;
}
