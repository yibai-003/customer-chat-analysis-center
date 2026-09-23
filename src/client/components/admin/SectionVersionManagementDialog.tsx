import { useEffect, useState } from "react";
import type { AnalysisSection, SectionConfigVersion } from "../../../shared/types";
import { api } from "../../api";
import { Modal } from "../Modal";

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

const statusLabel: Record<SectionConfigVersion["status"], string> = {
  draft: "草稿",
  published: "已发布",
  archived: "已归档",
};

export function SectionVersionManagementDialog({
  sections,
  close,
  saved,
}: {
  sections: AnalysisSection[];
  close: () => void;
  saved: () => void;
}) {
  const availableSections = sections.filter((section) => section.parentId);
  const [sectionId, setSectionId] = useState(availableSections[0]?.id ?? "");
  const [versions, setVersions] = useState<SectionConfigVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async (selectedSectionId = sectionId) => {
    if (!selectedSectionId) return;
    setLoading(true);
    setError("");
    try {
      setVersions(await api<SectionConfigVersion[]>(`/api/sections/${selectedSectionId}/versions`));
    } catch (loadError) {
      setError(message(loadError, "配置版本加载失败"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(sectionId); }, [sectionId]);

  const createDraft = async () => {
    if (!sectionId || busyId) return;
    setBusyId("create");
    setError("");
    setNotice("");
    try {
      const created = await api<SectionConfigVersion>(`/api/sections/${sectionId}/versions`, { method: "POST" });
      setNotice(`V${created.versionNumber} 草稿已创建`);
      await load();
    } catch (createError) {
      setError(message(createError, "创建草稿失败"));
    } finally {
      setBusyId("");
    }
  };

  const transition = async (
    version: SectionConfigVersion,
    action: "publish" | "archive" | "restore" | "activate" | "delete",
  ) => {
    if (busyId) return;
    setBusyId(version.id);
    setError("");
    setNotice("");
    try {
      if (action === "delete") {
        await api(`/api/section-config-versions/${version.id}`, { method: "DELETE" });
      } else {
        await api<SectionConfigVersion>(`/api/section-config-versions/${version.id}/${action}`, { method: "POST" });
      }
      const labels = {
        publish: "已发布并启用",
        archive: "已归档",
        restore: "已恢复为已发布版本",
        activate: "已重新启用",
        delete: "草稿已删除",
      };
      setNotice(`V${version.versionNumber} ${labels[action]}`);
      await load();
      saved();
    } catch (transitionError) {
      setError(message(transitionError, "版本状态更新失败"));
    } finally {
      setBusyId("");
    }
  };

  return <Modal title="配置版本管理" subtitle="发布、启用、归档和恢复板块配置快照" close={close}>
    {notice && <p className="notice" role="status">{notice}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="admin-create-form">
      <div className="form-grid">
        <label className="wide">分析板块
          <select aria-label="配置版本所属板块" value={sectionId} onChange={(event) => setSectionId(event.target.value)}>
            {availableSections.map((section) => <option value={section.id} key={section.id}>{section.name}</option>)}
          </select>
        </label>
      </div>
      <div className="modal-actions">
        <button type="button" className="button primary" disabled={!sectionId || Boolean(busyId)} onClick={() => void createDraft()}>
          {busyId === "create" ? "创建中..." : "基于当前配置创建草稿"}
        </button>
      </div>
    </div>
    <div className="admin-users-list">
      {versions.map((version) => <div className="admin-user-row version-row" key={version.id}>
        <div className="admin-user-identity">
          <strong>V{version.versionNumber}{version.isCurrent ? " · 当前启用" : ""}</strong>
          <span>{statusLabel[version.status]}</span>
          <small>更新于 {new Date(version.updatedAt).toLocaleString("zh-CN", { hour12: false })}</small>
        </div>
        <div className={`admin-user-state ${version.isCurrent ? "enabled" : "disabled"}`}>
          {version.isCurrent ? "当前" : statusLabel[version.status]}
        </div>
        <div className="admin-user-actions">
          {version.status === "draft" && <>
            <button type="button" className="button ghost" disabled={Boolean(busyId)} onClick={() => void transition(version, "publish")}>发布</button>
            <button type="button" className="button ghost" disabled={Boolean(busyId)} onClick={() => void transition(version, "delete")}>删除草稿</button>
          </>}
          {version.status === "published" && !version.isCurrent && <>
            <button type="button" className="button ghost" disabled={Boolean(busyId)} onClick={() => void transition(version, "activate")}>启用</button>
            <button type="button" className="button ghost" disabled={Boolean(busyId)} onClick={() => void transition(version, "archive")}>归档</button>
          </>}
          {version.status === "archived" && <button type="button" className="button ghost" disabled={Boolean(busyId)} onClick={() => void transition(version, "restore")}>恢复</button>}
        </div>
      </div>)}
      {loading && <p className="admin-users-loading">正在加载配置版本...</p>}
      {!loading && !versions.length && <p className="admin-users-loading">暂无配置版本。</p>}
    </div>
  </Modal>;
}
