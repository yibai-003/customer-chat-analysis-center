import { useEffect, useState } from "react";
import type { AnalysisSection, SectionConfigVersion } from "../../../shared/types";
import { api } from "../../api";
import { Modal } from "../Modal";

type ReceptionRule = {
  id: string;
  name: string;
  dimension: string;
  scope: string;
  criterion?: string;
  deduction: number;
  forceD: boolean;
  violationCount?: number;
  priority?: number;
  suggestion?: string;
};

type ReceptionBusinessRules = {
  kind?: string;
  issues: ReceptionRule[];
  [key: string]: unknown;
};

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function receptionRules(value: unknown): ReceptionRule[] {
  if (!value || typeof value !== "object") return [];
  const rules = (value as ReceptionBusinessRules).issues;
  return Array.isArray(rules) ? rules : [];
}

function cloneReceptionRules(value: unknown): ReceptionBusinessRules {
  const cloned = structuredClone(value ?? {}) as Partial<ReceptionBusinessRules>;
  return {
    ...cloned,
    issues: Array.isArray(cloned.issues) ? cloned.issues : [],
  };
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
  const [ruleVersion, setRuleVersion] = useState<SectionConfigVersion | null>(null);
  const [ruleLoadingId, setRuleLoadingId] = useState("");

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

  const viewRules = async (version: SectionConfigVersion) => {
    if (ruleLoadingId) return;
    setRuleLoadingId(version.id);
    setError("");
    try {
      setRuleVersion(await api<SectionConfigVersion>(`/api/section-config-versions/${version.id}`));
    } catch (ruleError) {
      setError(message(ruleError, "规则库加载失败"));
    } finally {
      setRuleLoadingId("");
    }
  };

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
          <select
            aria-label="配置版本所属板块"
            value={sectionId}
            onChange={(event) => {
              setRuleVersion(null);
              setSectionId(event.target.value);
            }}
          >
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
    {ruleVersion && <ReceptionRuleCatalog
      version={ruleVersion}
      close={() => setRuleVersion(null)}
    />}
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
          {sectionId === "reception" && <button
            type="button"
            className="button ghost"
            disabled={Boolean(busyId) || Boolean(ruleLoadingId)}
            onClick={() => void viewRules(version)}
          >
            {ruleLoadingId === version.id ? "加载中..." : "查看规则"}
          </button>}
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

function ReceptionRuleCatalog({
  version,
  close,
}: {
  version: SectionConfigVersion;
  close: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<ReceptionBusinessRules>(() => cloneReceptionRules(version.businessRules));
  const [savedRules, setSavedRules] = useState<ReceptionBusinessRules>(() => cloneReceptionRules(version.businessRules));
  const rules = editing ? draft.issues : savedRules.issues;

  useEffect(() => {
    setEditing(false);
    setSaving(false);
    setSaveError("");
    setNotice("");
    setDraft(cloneReceptionRules(version.businessRules));
    setSavedRules(cloneReceptionRules(version.businessRules));
  }, [version.id]);

  const updateRule = (id: string, patch: Partial<ReceptionRule>) => {
    setDraft((current) => ({
      ...current,
      issues: current.issues.map((rule) => rule.id === id ? { ...rule, ...patch } : rule),
    }));
  };

  const saveRules = async () => {
    if (version.status !== "draft" || saving) return;
    setSaving(true);
    setSaveError("");
    setNotice("");
    try {
      await api<SectionConfigVersion>(`/api/section-config-versions/${version.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessRules: draft }),
      });
      setSavedRules(cloneReceptionRules(draft));
      setEditing(false);
      setNotice("规则已保存");
    } catch (caught) {
      setSaveError(message(caught, "规则保存失败"));
    } finally {
      setSaving(false);
    }
  };

  return <section className="reception-rule-catalog" aria-label="接待质检规则库">
    <div className="reception-rule-catalog-header">
      <div>
        <small>RECEPTION QUALITY RULE CATALOG</small>
        <h3>接待质检规则库 · V{version.versionNumber}</h3>
        <p>{statusLabel[version.status]} · {version.isCurrent ? "当前启用" : "历史配置快照"}</p>
      </div>
      <div className="reception-rule-catalog-actions">
        {version.status === "draft" && !editing && <button
          type="button"
          className="button ghost"
          onClick={() => {
            setNotice("");
            setSaveError("");
            setDraft(cloneReceptionRules(savedRules));
            setEditing(true);
          }}
        >编辑草稿规则</button>}
        {editing && <>
          <button type="button" className="button primary" disabled={saving} onClick={() => void saveRules()}>
            {saving ? "保存中..." : "保存规则"}
          </button>
          <button type="button" className="button ghost" disabled={saving} onClick={() => {
            setDraft(cloneReceptionRules(savedRules));
            setEditing(false);
          }}>取消编辑</button>
        </>}
        <button type="button" className="button ghost" disabled={saving} onClick={close}>关闭规则</button>
      </div>
    </div>
    {notice && <p className="notice" role="status">{notice}</p>}
    {saveError && <p className="form-error" role="alert">{saveError}</p>}
    {!rules.length
      ? <p className="admin-users-loading">该版本没有可展示的接待质检规则。</p>
      : <div className="reception-rule-table-wrap">
        <table className="reception-rule-table">
          <thead>
            <tr>
              <th>规则ID</th>
              <th>问题</th>
              <th>维度</th>
              <th>范围</th>
              <th>扣分</th>
              <th>D级</th>
              <th>判定标准</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => <tr key={rule.id}>
              <td><code>{rule.id}</code></td>
              <td>{rule.name}</td>
              <td>{editing
                ? <input
                  aria-label={`规则 ${rule.id} 维度`}
                  value={rule.dimension}
                  onChange={(event) => updateRule(rule.id, { dimension: event.target.value })}
                />
                : rule.dimension}</td>
              <td>{rule.scope === "afterSale" ? "售后" : "售前"}</td>
              <td>{editing
                ? <input
                  aria-label={`规则 ${rule.id} 扣分`}
                  type="number"
                  min="0"
                  value={rule.deduction}
                  onChange={(event) => updateRule(rule.id, { deduction: Number(event.target.value) })}
                />
                : rule.deduction}</td>
              <td>{editing
                ? <input
                  aria-label={`规则 ${rule.id} D级`}
                  type="checkbox"
                  checked={rule.forceD}
                  onChange={(event) => updateRule(rule.id, { forceD: event.target.checked })}
                />
                : rule.forceD ? "是" : "否"}</td>
              <td>{editing
                ? <textarea
                  aria-label={`规则 ${rule.id} 判定标准`}
                  value={rule.criterion || ""}
                  onChange={(event) => updateRule(rule.id, { criterion: event.target.value })}
                />
                : rule.criterion || "未配置"}</td>
            </tr>)}
          </tbody>
        </table>
      </div>}
  </section>;
}
