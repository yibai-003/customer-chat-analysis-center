import { useEffect, useMemo, useState } from "react";
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

function statusFor(model: ModelConfig) {
  if (!model.isEnabled || !model.poolEnabled) return { text: "已禁用", tone: "muted" };
  if (model.quotaBlocked) return { text: "额度已耗尽", tone: "danger" };
  if (model.cooldownUntil) return { text: "冷却中", tone: "warning" };
  if (!model.capabilityEligible) return { text: "能力验证失败", tone: "danger" };
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
  refreshSettings,
  changed,
  reportError,
}: {
  pool: PoolData;
  settings: ModelPoolSettings;
  api: <T>(url: string, options?: RequestInit) => Promise<T>;
  refreshSettings: () => Promise<void>;
  changed: () => Promise<void>;
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
      setEditingId(null);
      setEditState(null);
      await changed();
    } catch (error) {
      reportError(error instanceof Error ? error.message : "模型池成员保存失败");
    }
  };

  const install = async () => {
    setInstalling(true);
    setMessage("正在安装或更新千问免费池...");
    try {
      const result = await api<InstallResult>("/api/model-pools/qianwen-free/install", {
        method: "POST",
      });
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
      await changed();
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
      await refreshSettings();
      setMessage("付费预算与能力验证时效已保存");
    } catch (error) {
      reportError(error instanceof Error ? error.message : "模型池设置保存失败");
    }
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

      <div className="model-purpose-tabs" aria-label="模型用途">
        <button
          type="button"
          className={purpose === "vision" ? "active" : ""}
          onClick={() => setPurpose("vision")}
        >
          视觉模型
        </button>
        <button
          type="button"
          className={purpose === "text" ? "active" : ""}
          onClick={() => setPurpose("text")}
        >
          文本模型
        </button>
      </div>

      {message && <div className="model-console-message" role="status">{message}</div>}

      <div className="model-table-scroll">
        <table className="model-pool-table">
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
              const status = statusFor(model);
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
                  <td>{model.capabilityEligible ? "已验证" : "未通过"}</td>
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
        </table>
      </div>

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
