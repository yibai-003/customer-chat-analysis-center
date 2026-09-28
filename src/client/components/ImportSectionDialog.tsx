import { useState } from "react";
import type { AnalysisSection, Platform } from "../../shared/types";
import { Modal } from "./Modal";
import { SelectMenu } from "./SelectMenu";

export function ImportSectionDialog({ file, sections, platforms, busy, error, onConfirm, onCancel }: {
  file: File; sections: AnalysisSection[]; platforms: Platform[]; busy: boolean;
  error?: string;
  onConfirm: (sectionId: string, platformId: string) => void; onCancel: () => void;
}) {
  const [sectionId, setSectionId] = useState("");
  const [platformId, setPlatformId] = useState("");
  const available = sections.filter((section) => section.parentId && section.isEnabled && section.currentVersionId);
  const availablePlatforms = platforms.filter((platform) => platform.isEnabled);
  return <Modal title="选择文件所属板块" subtitle="本次选择将绑定到新任务，不受当前查看的任务影响" close={() => { if (!busy) onCancel(); }}>
    <div className="import-preview-summary"><strong>{file.name}</strong></div>
    <div className="form-grid import-section-form"><label>解析板块
      <SelectMenu ariaLabel="文件所属解析板块" value={sectionId} disabled={busy} onChange={setSectionId} options={[
        { value: "", label: "请选择解析板块" },
        ...available.map((section) => ({ value: section.id, label: `${sections.find((parent) => parent.id === section.parentId)?.name} / ${section.name} · V${section.currentVersionNumber}` })),
      ]} />
    </label><label>平台
      <SelectMenu ariaLabel="文件所属平台" value={platformId} disabled={busy} onChange={setPlatformId} options={[
        { value: "", label: "请选择平台" },
        ...availablePlatforms.map((platform) => ({ value: platform.id, label: `${platform.name} · ${platform.code}` })),
      ]} />
    </label></div>
    {!available.length && <p role="status">暂无已启用的子板块，请先在板块配置中添加。</p>}
    {!availablePlatforms.length && <p role="status">暂无已启用的平台，请先维护平台字典。</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="modal-actions"><button className="button light" disabled={busy} onClick={onCancel}>取消</button><button className="button dark" disabled={busy || !available.some((section) => section.id === sectionId) || !availablePlatforms.some((platform) => platform.id === platformId)} onClick={() => onConfirm(sectionId, platformId)}>{busy ? "读取预览中..." : "下一步：预览文件"}</button></div>
  </Modal>;
}
