import { useState } from "react";
import type { ModelProvider } from "../../../shared/types";

type ProviderForm = {
  name: string;
  baseUrl: string;
  apiKey: string;
  isEnabled: boolean;
};

const emptyForm = (): ProviderForm => ({
  name: "",
  baseUrl: "",
  apiKey: "",
  isEnabled: true,
});

function formatDate(value?: string) {
  if (!value) return "尚未测试";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function ProviderView({
  providers,
  api,
  refreshProviders,
  refreshPool,
  markDirty,
  reportError,
}: {
  providers: ModelProvider[];
  api: <T>(url: string, options?: RequestInit) => Promise<T>;
  refreshProviders: () => Promise<void>;
  refreshPool: () => Promise<void>;
  markDirty: () => void;
  reportError: (message: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderForm>(emptyForm());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const edit = (provider: ModelProvider) => {
    setEditingId(provider.id);
    setForm({
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: "",
      isEnabled: provider.isEnabled,
    });
    setMessage("");
  };

  const reset = () => {
    setEditingId(null);
    setForm(emptyForm());
    setMessage("");
  };

  const save = async () => {
    setBusyId(editingId ?? "new");
    setMessage("");
    const action = editingId ? "更新" : "创建";
    try {
      const body: Partial<ProviderForm> = {
        name: form.name,
        baseUrl: form.baseUrl,
        isEnabled: form.isEnabled,
      };
      if (form.apiKey) body.apiKey = form.apiKey;
      await api(
        editingId ? `/api/model-providers/${editingId}` : "/api/model-providers",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    } catch (error) {
      reportError(error instanceof Error ? error.message : "服务商保存失败");
      setBusyId(null);
      return;
    }
    markDirty();
    reset();
    setMessage(`服务商已${action}`);
    const [providersResult, poolResult] = await Promise.allSettled([
      refreshProviders(),
      refreshPool(),
    ]);
    const refreshErrors: string[] = [];
    if (providersResult.status === "rejected") {
      refreshErrors.push(`服务商列表刷新失败：${
        providersResult.reason instanceof Error ? providersResult.reason.message : "刷新失败"
      }`);
    }
    if (poolResult.status === "rejected") {
      refreshErrors.push(`模型池刷新失败：${
        poolResult.reason instanceof Error ? poolResult.reason.message : "刷新失败"
      }`);
    }
    if (refreshErrors.length > 0) {
      reportError(`服务商已${action}，但${refreshErrors.join("；")}`);
    }
    setBusyId(null);
  };

  const testProvider = async (provider: ModelProvider) => {
    setBusyId(provider.id);
    setMessage(`正在测试 ${provider.name}...`);
    try {
      const result = await api<{ latencyMs: number }>(
        `/api/model-providers/${provider.id}/test`,
        { method: "POST" },
      );
      setMessage(`${provider.name} 连接成功，耗时 ${result.latencyMs}ms`);
    } catch (error) {
      const text = error instanceof Error ? error.message : "连接测试失败";
      setMessage(text);
      reportError(text);
    } finally {
      try {
        await refreshProviders();
      } catch (error) {
        reportError(`连接测试已完成，但服务商状态刷新失败：${
          error instanceof Error ? error.message : "刷新失败"
        }`);
      }
      setBusyId(null);
    }
  };

  return (
    <section className="provider-view" aria-label="服务商凭证">
      <div className="model-console-section-head">
        <div>
          <h3>服务商凭证</h3>
          <p>凭证输入框始终留空，已保存密钥仅显示掩码。</p>
        </div>
        <button className="model-console-command" type="button" onClick={reset}>新增服务商</button>
      </div>

      <div className="provider-list">
        {providers.map((provider) => (
          <article className="provider-row" key={provider.id}>
            <div className="provider-identity">
              <strong>{provider.name}</strong>
              <code>{provider.baseUrl}</code>
            </div>
            <div>
              <small>API Key</small>
              <code>{provider.maskedApiKey}</code>
            </div>
            <div>
              <small>状态</small>
              <span>{provider.isEnabled ? "已启用" : "已停用"}</span>
            </div>
            <div>
              <small>最近测试</small>
              <span>{formatDate(provider.lastTestedAt)}</span>
              {provider.lastError && <em>{provider.lastError}</em>}
            </div>
            <div className="provider-actions">
              <button
                type="button"
                disabled={busyId === provider.id}
                onClick={() => void testProvider(provider)}
              >
                测试
              </button>
              <button
                type="button"
                aria-label={`编辑${provider.name}`}
                onClick={() => edit(provider)}
              >
                编辑
              </button>
            </div>
          </article>
        ))}
        {providers.length === 0 && <div className="model-console-empty">尚未配置服务商凭证。</div>}
      </div>

      <form className="provider-form" onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}>
        <label>
          名称
          <input
            required
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </label>
        <label>
          Base URL
          <input
            required
            type="url"
            value={form.baseUrl}
            onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
          />
        </label>
        <label>
          API Key
          <input
            required={!editingId}
            type="password"
            autoComplete="new-password"
            placeholder={editingId ? "留空则保留原 Key" : "输入服务商 API Key"}
            value={form.apiKey}
            onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
          />
        </label>
        <label className="model-console-check">
          <input
            type="checkbox"
            checked={form.isEnabled}
            onChange={(event) => setForm({ ...form, isEnabled: event.target.checked })}
          />
          启用服务商
        </label>
        <div className="provider-form-actions">
          {editingId && <button type="button" onClick={reset}>取消</button>}
          <button className="model-console-command primary" type="submit" disabled={busyId !== null}>
            {editingId ? "保存服务商" : "创建服务商"}
          </button>
        </div>
      </form>
      {message && <div className="model-console-message" role="status">{message}</div>}
    </section>
  );
}
