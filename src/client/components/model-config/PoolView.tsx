import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type {
  ModelBillingMode,
  ModelConfig,
  ModelPoolSettings,
  ModelPurpose,
  ModelQualityTier,
} from "../../../shared/types";

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

function formatTokens(value?: number) {
  if (value == null) return "不限";
  return new Intl.NumberFormat("zh-CN").format(value);
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

function statusFor(model: ModelConfig, capabilityState: CapabilityState) {
  if (!model.isEnabled || !model.poolEnabled) return { text: "已禁用", tone: "muted" };
  if (model.quotaBlocked) return { text: "额度已耗尽", tone: "danger" };
  if (model.cooldownUntil) return { text: "冷却中", tone: "warning" };
  if (capabilityState !== "verified") {
    const capability = capabilityLabels[capabilityState];
    return { text: capability.status, tone: capability.tone };
  }
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
  const [message, setMessage] = useState("");
  const [settingsForm, setSettingsForm] = useState(settings);

  useEffect(() => setSettingsForm(settings), [settings]);

  const members = useMemo(
    () => pool.members.filter((model) => model.purpose === purpose),
    [pool.members, purpose],
  );
  const summary = pool.summary[purpose];

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

      {message && <div className="model-console-message" role="status">{message}</div>}

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
              const remaining = model.quotaTotalTokens == null
                ? undefined
                : Math.max(0, model.quotaTotalTokens - model.quotaUsedTokens);
              const capabilityState = capabilityStateFor(model, settings.capabilityTtlMs);
              const capability = capabilityLabels[capabilityState];
              const status = statusFor(model, capabilityState);
              return (
                <tr key={model.id}>
                  <td className="model-name-cell">
                    <strong>{model.name}</strong>
                    <code>{model.model}</code>
                    <small>{model.providerName ?? "未绑定服务商"}</small>
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
                    ) : `${formatTokens(model.quotaUsedTokens)} / ${formatTokens(model.quotaTotalTokens)}`}
                  </td>
                  <td>{formatTokens(remaining)}</td>
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
                  <td><span className={`model-status ${status.tone}`}>{status.text}</span></td>
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
              <tr><td colSpan={11} className="model-console-empty">该用途暂无模型池成员。</td></tr>
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
