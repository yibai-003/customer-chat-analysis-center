import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type {
  ModelBillingMode,
  ModelConfig,
  ModelPoolSettings,
  ModelPurpose,
  ModelQualityTier,
} from "../../../shared/types";
import { PoolCheckbox } from "./PoolCheckbox";
import { QuotaMeter } from "./QuotaMeter";
import {
  formatQuotaTokens,
  quotaPresentation,
  type QuotaPresentation,
} from "./quota-presentation";

type PoolSummaryItem = { total: number; enabled: number; verified: number; blocked: number };
export type PoolData = {
  members: ModelConfig[];
  summary: {
    total: number;
    vision: PoolSummaryItem;
    text: PoolSummaryItem;
  };
};

type EditState = {
  qualityTier: ModelQualityTier;
  billingMode: ModelBillingMode;
  quotaUsedTokens: string;
  quotaTotalTokens: string;
  quotaExpiresAt: string;
  quotaSafetyRatio: string;
  priority: string;
  isEnabled: boolean;
  poolEnabled: boolean;
};

type InstallResult = {
  created: string[];
  updated: string[];
  needsVerification: string[];
};

type RemovalReason = "verify_failed" | "unstable" | "quota" | "maintenance";

const removalReasonLabels: Record<RemovalReason, string> = {
  verify_failed: "验证失败",
  unstable: "稳定性差",
  quota: "额度/限流",
  maintenance: "人工维护",
};

function eligibleForRouting(model: ModelConfig) {
  return model.isEnabled && model.poolEnabled && model.capabilityEligible
    && !model.quotaBlocked && !model.cooldownUntil;
}

function chunk<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function localDateTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function displayDate(value?: string) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "不限";
}

type CapabilityState = "verified" | "never" | "expired" | "failed";

function capabilityStateFor(
  model: ModelConfig,
  capabilityTtlMs: number,
  now = Date.now(),
): CapabilityState {
  if (!model.capabilityCheckedAt) return "never";
  const checkedAt = Date.parse(model.capabilityCheckedAt);
  const fresh = Number.isFinite(checkedAt)
    && now >= checkedAt
    && now - checkedAt < capabilityTtlMs;
  if (!fresh) return "expired";
  const capability = model.capabilityStatus;
  const passed = capability?.text === true
    && capability.json === true
    && (model.purpose === "text" || (model.supportsVision && capability.vision === true));
  return passed ? "verified" : "failed";
}

const capabilityLabels: Record<CapabilityState, { column: string; status: string; tone: string }> = {
  verified: { column: "已验证", status: "", tone: "ready" },
  never: { column: "未验证", status: "待能力验证", tone: "warning" },
  expired: { column: "验证已过期", status: "验证已过期", tone: "warning" },
  failed: { column: "能力验证失败", status: "能力验证失败", tone: "danger" },
};

function statusFor(
  model: ModelConfig,
  capabilityState: CapabilityState,
  quota: QuotaPresentation,
) {
  if (!model.isEnabled || !model.poolEnabled) return { text: "已禁用", tone: "muted" };
  if (quota.tone === "exhausted") return { text: quota.statusText, tone: "danger" };
  if (model.cooldownUntil) return { text: "冷却中", tone: "warning" };
  if (capabilityState !== "verified") {
    const capability = capabilityLabels[capabilityState];
    return { text: capability.status, tone: capability.tone };
  }
  if (quota.tone === "warning") return { text: quota.statusText, tone: "warning" };
  if (model.billingMode === "paid") return { text: "付费可用", tone: "paid" };
  return { text: "可调用", tone: "ready" };
}

function initialEdit(model: ModelConfig): EditState {
  return {
    qualityTier: model.qualityTier,
    billingMode: model.billingMode,
    quotaUsedTokens: String(model.quotaUsedTokens),
    quotaTotalTokens: model.quotaTotalTokens == null ? "" : String(model.quotaTotalTokens),
    quotaExpiresAt: localDateTime(model.quotaExpiresAt),
    quotaSafetyRatio: String(model.quotaSafetyRatio),
    priority: String(model.priority),
    isEnabled: model.isEnabled,
    poolEnabled: model.poolEnabled,
  };
}

export function PoolView({
  pool,
  settings,
  api,
  refreshPool,
  refreshSettings,
  markDirty,
  reportError,
}: {
  pool: PoolData;
  settings: ModelPoolSettings;
  api: <T>(url: string, options?: RequestInit) => Promise<T>;
  refreshPool: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  markDirty: () => void;
  reportError: (message: string) => void;
}) {
  const [purpose, setPurpose] = useState<ModelPurpose>("vision");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [installing, setInstalling] = useState(false);
  const [verifyingDefaults, setVerifyingDefaults] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [removalReason, setRemovalReason] = useState<RemovalReason>("maintenance");
  const [removalNote, setRemovalNote] = useState("");
  const [message, setMessage] = useState("");
  const [settingsForm, setSettingsForm] = useState(settings);

  useEffect(() => setSettingsForm(settings), [settings]);

  const members = useMemo(
    () => pool.members.filter((model) => model.purpose === purpose),
    [pool.members, purpose],
  );
  const summary = pool.summary[purpose];
  const selectedMembers = pool.members.filter((model) => selectedIds.includes(model.id));
  const visibleSelectedCount = members.filter((model) => selectedIds.includes(model.id)).length;
  const visibleSelected = members.length > 0 && visibleSelectedCount === members.length;
  const visiblePartiallySelected = visibleSelectedCount > 0
    && visibleSelectedCount < members.length;
  const selectedEligible = selectedMembers.filter(eligibleForRouting);
  const affectedPurposes = (["vision", "text"] as const).filter((panelPurpose) => {
    const removing = selectedEligible.filter((model) => model.purpose === panelPurpose);
    if (!removing.length) return false;
    return !pool.members.some((model) => model.purpose === panelPurpose
      && eligibleForRouting(model) && !selectedIds.includes(model.id));
  });
  const pendingDefaults = useMemo(() => pool.members.filter((model) => (
    model.isPurposeDefault
    && model.isEnabled
    && model.memberType === "general"
    && (!model.capabilityEligible || !model.poolEnabled)
    && !model.quotaBlocked
    && !model.cooldownUntil
  )), [pool.members]);

  const beginEdit = (model: ModelConfig) => {
    setEditingId(model.id);
    setEditState(initialEdit(model));
  };

  const saveMember = async (model: ModelConfig) => {
    if (!editState) return;
    try {
      await api(`/api/model-pool-members/${model.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qualityTier: editState.qualityTier,
          billingMode: editState.billingMode,
          quotaUsedTokens: Number(editState.quotaUsedTokens || 0),
          quotaTotalTokens: editState.quotaTotalTokens === ""
            ? null
            : Number(editState.quotaTotalTokens),
          quotaExpiresAt: editState.quotaExpiresAt
            ? new Date(editState.quotaExpiresAt).toISOString()
            : null,
          priority: Number(editState.priority || 0),
          isEnabled: editState.isEnabled,
          poolEnabled: editState.poolEnabled,
          quotaSafetyRatio: Number(editState.quotaSafetyRatio || 0.95),
        }),
      });
    } catch (error) {
      reportError(error instanceof Error ? error.message : "模型池成员保存失败");
      return;
    }
    markDirty();
    setEditingId(null);
    setEditState(null);
    try {
      await refreshPool();
    } catch (error) {
      reportError(`模型池成员已保存，但列表刷新失败：${
        error instanceof Error ? error.message : "刷新失败"
      }`);
    }
  };

  const install = async () => {
    setInstalling(true);
    setMessage("正在安装或更新千问免费池...");
    let mutated = false;
    try {
      const result = await api<InstallResult>("/api/model-pools/qianwen-free/install", {
        method: "POST",
      });
      mutated = true;
      markDirty();
      const createdSet = new Set(result.created);
      const preExisting = result.needsVerification.filter((id) => !createdSet.has(id));
      const created = result.needsVerification.filter((id) => createdSet.has(id));
      const batches = [
        ...chunk(preExisting, 50).map((ids) => ({ ids, enablePassed: false })),
        ...chunk(created, 50).map((ids) => ({ ids, enablePassed: true })),
      ];
      let verified = 0;
      setMessage(
        `新建 ${result.created.length}，更新 ${result.updated.length}，待验证 ${result.needsVerification.length}`,
      );
      for (const batch of batches) {
        await api("/api/model-pools/qianwen-free/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batch),
        });
        verified += batch.ids.length;
        setMessage(
          `新建 ${result.created.length}，更新 ${result.updated.length}，已验证 ${verified}/${result.needsVerification.length}`,
        );
      }
      setMessage(
        `新建 ${result.created.length}，更新 ${result.updated.length}，验证完成 ${verified}/${result.needsVerification.length}`,
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : "千问免费池安装失败";
      setMessage(text);
      reportError(text);
    } finally {
      setInstalling(false);
    }
    if (!mutated) return;
    try {
      await refreshPool();
    } catch (error) {
      reportError(`千问免费池已变更，但列表刷新失败：${
        error instanceof Error ? error.message : "刷新失败"
      }`);
    }
  };

  const verifyDefaults = async () => {
    const ids = pendingDefaults.map((model) => model.id);
    if (!ids.length) return;
    setVerifyingDefaults(true);
    setMessage("正在验证默认模型...");
    let mutated = false;
    try {
      const results = await api<Array<{ id: string; passed: boolean; error?: string }>>(
        "/api/model-pools/qianwen-free/verify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids, enablePassed: true }),
        },
      );
      mutated = true;
      markDirty();
      const passed = results.filter((result) => result.passed).length;
      setMessage(`默认模型验证完成：通过 ${passed}/${results.length}`);
    } catch (error) {
      const text = error instanceof Error ? error.message : "默认模型验证失败";
      setMessage(text);
      reportError(text);
    } finally {
      setVerifyingDefaults(false);
    }
    if (!mutated) return;
    try {
      await refreshPool();
    } catch (error) {
      reportError(`默认模型状态已变更，但列表刷新失败：${
        error instanceof Error ? error.message : "刷新失败"
      }`);
    }
  };

  const refreshAfterMutation = async (label: string) => {
    markDirty();
    try {
      await refreshPool();
    } catch (error) {
      reportError(`${label}已变更，但列表刷新失败：${
        error instanceof Error ? error.message : "刷新失败"
      }`);
    }
  };

  const bulkVerify = async (ids: string[]) => {
    if (!ids.length) return;
    setBulkBusy(true);
    setMessage("正在验证选中的模型...");
    let mutated = false;
    try {
      const results = await api<Array<{ id: string; passed: boolean; error?: string }>>(
        "/api/model-pool-members/verify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids, enablePassed: true }),
        },
      );
      mutated = true;
      const passed = results.filter((result) => result.passed).length;
      setMessage(`验证完成：通过 ${passed}/${results.length}`);
    } catch (error) {
      const text = error instanceof Error ? error.message : "批量验证失败";
      setMessage(text);
      reportError(text);
    } finally {
      setBulkBusy(false);
    }
    if (mutated) await refreshAfterMutation("验证结果");
  };

  const verifyProblems = () => void bulkVerify(members
    .filter((model) => capabilityStateFor(model, settings.capabilityTtlMs) !== "verified")
    .map((model) => model.id));

  const removeSelected = async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      await api("/api/model-pool-members/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, reason: removalReason, note: removalNote || undefined }),
      });
      setSelectedIds([]);
      setConfirmingRemoval(false);
      setRemovalNote("");
      setMessage(`已剔除 ${ids.length} 个成员，配置和历史运行保留`);
    } catch (error) {
      const text = error instanceof Error ? error.message : "剔除失败";
      setMessage(text);
      reportError(text);
      setBulkBusy(false);
      return;
    }
    setBulkBusy(false);
    await refreshAfterMutation("成员状态");
  };

  const restoreSelected = async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      await api("/api/model-pool-members/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      setMessage(`已恢复 ${ids.length} 个成员，需重新验证后才可参与路由`);
    } catch (error) {
      const text = error instanceof Error ? error.message : "恢复失败";
      setMessage(text);
      reportError(text);
      setBulkBusy(false);
      return;
    }
    setBulkBusy(false);
    await refreshAfterMutation("成员状态");
  };

  const toggleSelected = (id: string) => setSelectedIds((current) => (
    current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
  ));

  const toggleVisible = () => setSelectedIds((current) => (
    visibleSelected
      ? current.filter((id) => !members.some((model) => model.id === id))
      : [...new Set([...current, ...members.map((model) => model.id)])]
  ));

  const saveSettings = async () => {
    try {
      await api("/api/model-pool-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paidDailyTokenLimit: Number(settingsForm.paidDailyTokenLimit || 0),
          paidMonthlyTokenLimit: Number(settingsForm.paidMonthlyTokenLimit || 0),
          capabilityTtlMs: Number(settingsForm.capabilityTtlMs),
        }),
      });
    } catch (error) {
      reportError(error instanceof Error ? error.message : "模型池设置保存失败");
      return;
    }
    markDirty();
    setMessage("付费预算与能力验证时效已保存");
    try {
      await refreshSettings();
    } catch (error) {
      reportError(`模型池设置已保存，但刷新失败：${
        error instanceof Error ? error.message : "刷新失败"
      }`);
    }
  };

  const selectPurpose = (nextPurpose: ModelPurpose, focus = false) => {
    setPurpose(nextPurpose);
    setSelectedIds([]);
    setConfirmingRemoval(false);
    if (focus) document.getElementById(`model-pool-purpose-tab-${nextPurpose}`)?.focus();
  };

  const handlePurposeKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentPurpose: ModelPurpose,
  ) => {
    let nextPurpose: ModelPurpose | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      nextPurpose = currentPurpose === "vision" ? "text" : "vision";
    }
    if (event.key === "Home") nextPurpose = "vision";
    if (event.key === "End") nextPurpose = "text";
    if (!nextPurpose) return;
    event.preventDefault();
    selectPurpose(nextPurpose, true);
  };

  return (
    <section className="pool-view" aria-label="模型池">
      <div className="model-console-section-head">
        <div>
          <h3>模型池</h3>
          <p>
            当前 {summary.total} 个，启用 {summary.enabled}，验证通过 {summary.verified}，
            受限 {summary.blocked}
          </p>
        </div>
        <button
          className="model-console-command primary"
          type="button"
          disabled={installing}
          onClick={() => void install()}
        >
          安装/更新千问免费池
        </button>
      </div>

      <div className="model-purpose-tabs" role="tablist" aria-label="模型用途">
        <button
          id="model-pool-purpose-tab-vision"
          type="button"
          role="tab"
          aria-selected={purpose === "vision"}
          aria-controls="model-pool-purpose-panel-vision"
          tabIndex={purpose === "vision" ? 0 : -1}
          className={purpose === "vision" ? "active" : ""}
          onClick={() => selectPurpose("vision")}
          onKeyDown={(event) => handlePurposeKeyDown(event, "vision")}
        >
          视觉模型
        </button>
        <button
          id="model-pool-purpose-tab-text"
          type="button"
          role="tab"
          aria-selected={purpose === "text"}
          aria-controls="model-pool-purpose-panel-text"
          tabIndex={purpose === "text" ? 0 : -1}
          className={purpose === "text" ? "active" : ""}
          onClick={() => selectPurpose("text")}
          onKeyDown={(event) => handlePurposeKeyDown(event, "text")}
        >
          文本模型
        </button>
      </div>

      {pendingDefaults.length > 0 && (
        <div className="pool-readiness" role="alert">
          <span>
            默认模型尚未验证或未入池：
            {pendingDefaults.map((model) => model.name).join("、")}
            。验证通过后将自动入池。
          </span>
          <button
            className="model-console-command"
            type="button"
            disabled={verifyingDefaults}
            onClick={() => void verifyDefaults()}
          >
            {verifyingDefaults ? "验证中…" : "验证默认模型"}
          </button>
        </div>
      )}

      {message && <div className="model-console-message" role="status">{message}</div>}

      <div className="pool-bulk-bar" role="group" aria-label="模型池批量操作">
        <span>{selectedIds.length ? `已选 ${selectedIds.length} 个` : "未选择成员"}</span>
        <button type="button" disabled={!selectedIds.length || bulkBusy}
          title={selectedIds.length ? "验证选中成员" : "先选择成员"}
          onClick={() => void bulkVerify(selectedIds)}>验证已选</button>
        <button type="button" disabled={!members.length || bulkBusy}
          title={members.length ? "验证本用途未通过的成员" : "该用途暂无成员"}
          onClick={verifyProblems}>验证失败/过期项</button>
        <button type="button" disabled={!selectedIds.length || bulkBusy}
          title={selectedIds.length ? "从路由池剔除，保留配置与历史" : "先选择成员"}
          onClick={() => setConfirmingRemoval(true)}>剔除已选</button>
        <button type="button" disabled={!selectedIds.length || bulkBusy}
          title={selectedIds.length ? "恢复入池，需重新验证" : "先选择成员"}
          onClick={() => void restoreSelected()}>恢复已选</button>
        {selectedIds.length > 0 && <button type="button" disabled={bulkBusy}
          onClick={() => { setSelectedIds([]); setConfirmingRemoval(false); }}>清空选择</button>}
      </div>

      {confirmingRemoval && (
        <div className="pool-removal-confirm" role="alertdialog" aria-label="确认剔除成员">
          <p>
            将剔除 {selectedIds.length} 个成员；模型配置、服务商关联、历史运行与使用事件保留。
            {affectedPurposes.length > 0 && (
              <strong>
                注意：{affectedPurposes.map((item) => item === "vision" ? "视觉" : "文本").join("、")}
                用途将进入未就绪状态，不会自动改用付费或其他用途模型。
              </strong>
            )}
          </p>
          <label>剔除原因
            <select aria-label="剔除原因" value={removalReason}
              onChange={(event) => setRemovalReason(event.target.value as RemovalReason)}>
              {(Object.keys(removalReasonLabels) as RemovalReason[]).map((reason) => (
                <option key={reason} value={reason}>{removalReasonLabels[reason]}</option>
              ))}
            </select>
          </label>
          <label>补充说明
            <input aria-label="剔除补充说明" maxLength={200} value={removalNote}
              onChange={(event) => setRemovalNote(event.target.value)} />
          </label>
          <span className="model-row-actions">
            <button type="button" disabled={bulkBusy} onClick={() => void removeSelected()}>确认剔除</button>
            <button type="button" disabled={bulkBusy} onClick={() => setConfirmingRemoval(false)}>取消</button>
          </span>
        </div>
      )}

      {(["vision", "text"] as const).map((panelPurpose) => (
        <div
          key={panelPurpose}
          id={`model-pool-purpose-panel-${panelPurpose}`}
          className="model-table-scroll"
          role="tabpanel"
          aria-labelledby={`model-pool-purpose-tab-${panelPurpose}`}
          hidden={purpose !== panelPurpose}
        >
          {purpose === panelPurpose && <table className="model-pool-table">
          <thead>
            <tr>
              <th>
                <PoolCheckbox
                  label="全选当前用途成员"
                  checked={visibleSelected}
                  indeterminate={visiblePartiallySelected}
                  disabled={!members.length}
                  onChange={toggleVisible}
                />
              </th>
              <th>模型</th>
              <th>等级</th>
              <th>计费</th>
              <th>已用/总额</th>
              <th>剩余</th>
              <th>到期</th>
              <th>能力</th>
              <th>冷却</th>
              <th>优先级</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {members.map((model) => {
              const editing = editingId === model.id && editState;
              const quota = quotaPresentation(model);
              const selected = selectedIds.includes(model.id);
              const capabilityState = capabilityStateFor(model, settings.capabilityTtlMs);
              const capability = capabilityLabels[capabilityState];
              const status = statusFor(model, capabilityState, quota);
              const providerName = model.providerName ?? "未绑定服务商";
              return (
                <tr key={model.id} className={selected ? "selected" : undefined}>
                  <td>
                    <PoolCheckbox
                      label={`选择成员 ${model.name}`}
                      checked={selected}
                      onChange={() => toggleSelected(model.id)}
                    />
                  </td>
                  <td className="model-name-cell">
                    <strong title={model.name}>{model.name}</strong>
                    <code title={model.model}>{model.model}</code>
                    <small title={providerName}>{providerName}</small>
                    {editing && (
                      <div className="model-row-toggles">
                        <label>
                          <input
                            aria-label="启用模型"
                            type="checkbox"
                            checked={editState.isEnabled}
                            onChange={(event) => setEditState({
                              ...editState,
                              isEnabled: event.target.checked,
                            })}
                          />
                          启用
                        </label>
                        <label>
                          <input
                            aria-label="加入模型池"
                            type="checkbox"
                            checked={editState.poolEnabled}
                            onChange={(event) => setEditState({
                              ...editState,
                              poolEnabled: event.target.checked,
                            })}
                          />
                          入池
                        </label>
                      </div>
                    )}
                  </td>
                  <td>
                    {editing ? (
                      <select
                        aria-label="等级"
                        value={editState.qualityTier}
                        onChange={(event) => setEditState({
                          ...editState,
                          qualityTier: event.target.value as ModelQualityTier,
                        })}
                      >
                        <option>A</option><option>B</option><option>C</option>
                      </select>
                    ) : model.qualityTier}
                  </td>
                  <td>
                    {editing ? (
                      <select
                        aria-label="计费"
                        value={editState.billingMode}
                        onChange={(event) => setEditState({
                          ...editState,
                          billingMode: event.target.value as ModelBillingMode,
                        })}
                      >
                        <option value="free">免费</option>
                        <option value="paid">付费</option>
                      </select>
                    ) : model.billingMode === "free" ? "免费" : "付费"}
                  </td>
                  <td>
                    {editing ? (
                      <span className="model-inline-inputs">
                        <input
                          aria-label="已用 Token"
                          type="number"
                          min="0"
                          value={editState.quotaUsedTokens}
                          onChange={(event) => setEditState({
                            ...editState,
                            quotaUsedTokens: event.target.value,
                          })}
                        />
                        <input
                          aria-label="总额 Token"
                          type="number"
                          min="0"
                          value={editState.quotaTotalTokens}
                          onChange={(event) => setEditState({
                            ...editState,
                            quotaTotalTokens: event.target.value,
                          })}
                        />
                      </span>
                    ) : <QuotaMeter modelName={model.name} quota={quota} />}
                  </td>
                  <td>
                    {quota.remaining == null ? "—" : formatQuotaTokens(quota.remaining)}
                  </td>
                  <td>
                    {editing ? (
                      <input
                        aria-label="到期时间"
                        type="datetime-local"
                        value={editState.quotaExpiresAt}
                        onChange={(event) => setEditState({
                          ...editState,
                          quotaExpiresAt: event.target.value,
                        })}
                      />
                    ) : displayDate(model.quotaExpiresAt)}
                  </td>
                  <td>{capability.column}</td>
                  <td>{model.cooldownUntil ? displayDate(model.cooldownUntil) : "无"}</td>
                  <td>
                    {editing ? (
                      <input
                        aria-label="优先级"
                        type="number"
                        min="0"
                        value={editState.priority}
                        onChange={(event) => setEditState({
                          ...editState,
                          priority: event.target.value,
                        })}
                      />
                    ) : model.priority}
                  </td>
                  <td>
                    <span className={`model-status ${status.tone}`}>{status.text}</span>
                    {model.poolRemovedReason && (
                      <small className="model-status-note">
                        已剔除：{removalReasonLabels[model.poolRemovedReason]}
                        {model.poolRemovedAt ? ` · ${displayDate(model.poolRemovedAt)}` : ""}
                      </small>
                    )}
                    {model.consecutiveFailures > 0 && (
                      <small className="model-status-note">
                        连续失败 {model.consecutiveFailures} 次
                        {model.lastFailureAt ? ` · ${displayDate(model.lastFailureAt)}` : ""}
                      </small>
                    )}
                  </td>
                  <td>
                    {editing ? (
                      <span className="model-row-actions">
                        <button type="button" onClick={() => void saveMember(model)}>保存</button>
                        <button type="button" onClick={() => {
                          setEditingId(null);
                          setEditState(null);
                        }}>取消</button>
                      </span>
                    ) : <button type="button" onClick={() => beginEdit(model)}>编辑</button>}
                  </td>
                </tr>
              );
            })}
            {members.length === 0 && (
              <tr><td colSpan={12} className="model-console-empty">该用途暂无模型池成员。</td></tr>
            )}
          </tbody>
          </table>}
        </div>
      ))}

      <div className="model-pool-settings">
        <label>
          付费日预算
          <input
            type="number"
            min="0"
            value={settingsForm.paidDailyTokenLimit}
            onChange={(event) => setSettingsForm({
              ...settingsForm,
              paidDailyTokenLimit: Number(event.target.value),
            })}
          />
        </label>
        <label>
          付费月预算
          <input
            type="number"
            min="0"
            value={settingsForm.paidMonthlyTokenLimit}
            onChange={(event) => setSettingsForm({
              ...settingsForm,
              paidMonthlyTokenLimit: Number(event.target.value),
            })}
          />
        </label>
        <label>
          能力验证有效期（毫秒）
          <input
            type="number"
            min="1"
            value={settingsForm.capabilityTtlMs}
            onChange={(event) => setSettingsForm({
              ...settingsForm,
              capabilityTtlMs: Number(event.target.value),
            })}
          />
        </label>
        <button type="button" onClick={() => void saveSettings()}>保存池设置</button>
      </div>
    </section>
  );
}
