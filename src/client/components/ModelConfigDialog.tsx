import { useState } from "react";
import type { ModelConfig } from "../../shared/types";
import { Modal } from "./Modal";
import { AlertDialog } from "./AlertDialog";
import { ConfirmDialog } from "./ConfirmDialog";

const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(body.error || "请求失败");
  return body.data as T;
};

type ModelForm = Pick<
  ModelConfig,
  "name" | "baseUrl" | "model" | "supportsVision" | "purpose" | "isPurposeDefault"
  | "temperature" | "maxTokens" | "isEnabled"
> & { apiKey: string };
const emptyForm = (): ModelForm => ({ name: "截图提取模型", baseUrl: "", apiKey: "", model: "", supportsVision: true, purpose: "vision", isPurposeDefault: false, temperature: 0.2, maxTokens: 1500, isEnabled: true });

export function ModelConfigDialog({ models, close, saved }: { models: ModelConfig[]; close: () => void; saved: () => void }) {
  const [form, setForm] = useState<ModelForm>(emptyForm());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ModelConfig | null>(null);
  const [testMessage, setTestMessage] = useState("");
  const [capabilityMessage, setCapabilityMessage] = useState<Record<string, string>>({});
  const update = (patch: Partial<ModelForm>) => setForm((current) => ({ ...current, ...patch }));
  const edit = (model: ModelConfig) => {
    setEditingId(model.id);
    setError("");
    setForm({ name: model.name, baseUrl: model.baseUrl, apiKey: "", model: model.model, supportsVision: model.supportsVision, purpose: model.purpose, isPurposeDefault: model.isPurposeDefault, temperature: model.temperature, maxTokens: model.maxTokens, isEnabled: model.isEnabled });
  };
  const resetForm = () => { setEditingId(null); setForm(emptyForm()); setError(""); };
  const save = async () => {
    try {
      await api(editingId ? `/api/model-configs/${editingId}` : "/api/model-configs", { method: editingId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      saved();
    } catch (error) { setError(error instanceof Error ? error.message : "保存失败"); }
  };
  const remove = (id: string) => {
    setPendingDelete(models.find((model) => model.id === id) ?? null);
  };
  const confirmRemove = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    try { await api(`/api/model-configs/${id}`, { method: "DELETE" }); if (editingId === id) resetForm(); saved(); }
    catch (error) { setError(error instanceof Error ? error.message : "删除失败"); }
  };
  const setDefault = async (id: string) => {
    try { await api(`/api/model-configs/${id}/default`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: models.find((model) => model.id === id)?.purpose }) }); saved(); }
    catch (error) { setError(error instanceof Error ? error.message : "设置默认失败"); }
  };
  const test = async (id: string) => {
    setTestMessage("正在测试连接...");
    try { const result = await api<{ latencyMs: number }>(`/api/model-configs/${id}/test`, { method: "POST" }); setTestMessage(`连接成功，耗时 ${result.latencyMs}ms`); }
    catch (error) { setTestMessage(error instanceof Error ? error.message : "连接失败"); }
  };
  const testCapabilities = async (id: string) => {
    setCapabilityMessage((current) => ({ ...current, [id]: "正在检测文本、JSON 和视觉能力..." }));
    try {
      const result = await api<{ capabilities: { text: boolean; json: boolean; vision: boolean } }>(`/api/model-configs/${id}/test-capabilities`, { method: "POST" });
      const c = result.capabilities;
      setCapabilityMessage((current) => ({ ...current, [id]: `文本 ${c.text ? "✓" : "✗"} · JSON ${c.json ? "✓" : "✗"} · 视觉 ${c.vision ? "✓" : "✗"}` }));
    } catch (error) { setCapabilityMessage((current) => ({ ...current, [id]: error instanceof Error ? error.message : "能力检测失败" })); }
  };
  return <Modal title="模型配置" subtitle="截图提取和字段分析分别使用对应模型，可配置备用模型" close={close}>
    <div className="config-list">{(["vision", "text"] as const).map((purpose) => <section className="model-group" key={purpose}><h3>{purpose === "vision" ? "截图提取模型" : "字段分析模型"} <small>{purpose === "vision" ? "需要支持图片输入" : "结合截图结果和辅助字段"}</small></h3>{models.filter((model) => model.purpose === purpose).map((model) => <div className="config-item" key={model.id}><b>AI</b><span><strong>{model.name}</strong><small>{model.model} · {model.maskedApiKey}</small>{capabilityMessage[model.id] && <small className="model-capability">{capabilityMessage[model.id]}</small>}</span><button onClick={() => test(model.id)}>测试连接</button><button onClick={() => testCapabilities(model.id)}>能力检测</button>{model.isPurposeDefault ? <em>主模型</em> : <button onClick={() => setDefault(model.id)}>设为主模型</button>}<button onClick={() => edit(model)}>编辑</button><button className="danger-text" onClick={() => remove(model.id)}>删除</button></div>)}</section>)}</div>
    {testMessage && <div className="notice">{testMessage}</div>}
    <div className="form-grid">
      <label>配置名称<input value={form.name} onChange={(event) => update({ name: event.target.value })} /></label>
      <label>模型名称<input placeholder="gpt-4o" value={form.model} onChange={(event) => update({ model: event.target.value })} /></label>
      <label>模型用途<select value={form.purpose} onChange={(event) => update({ purpose: event.target.value as ModelForm["purpose"], supportsVision: event.target.value === "vision" })}><option value="vision">截图提取模型</option><option value="text">字段分析模型</option></select></label>
      <label className="wide">Base URL<input placeholder="https://api.example.com/v1" value={form.baseUrl} onChange={(event) => update({ baseUrl: event.target.value })} /></label>
      <label className="wide">API Key<input type="password" placeholder={editingId ? "留空则保留原 Key" : "sk-..."} value={form.apiKey} onChange={(event) => update({ apiKey: event.target.value })} /></label>
      <label>Temperature<input type="number" step=".1" value={form.temperature} onChange={(event) => update({ temperature: Number(event.target.value) })} /></label>
      <label>Max Tokens<input type="number" value={form.maxTokens} onChange={(event) => update({ maxTokens: Number(event.target.value) })} /></label>
    </div>
    {error && <AlertDialog title="模型配置操作失败" message={error} close={() => setError("")} />}
    <div className="modal-actions"><button className="button light" onClick={resetForm}>新建配置</button><button className="button dark" onClick={save}>{editingId ? "更新配置 →" : "保存配置 →"}</button></div>
    {pendingDelete && <ConfirmDialog title="删除模型配置" message={`确认删除“${pendingDelete.name}”吗？默认模型需要先切换。`} onConfirm={confirmRemove} onCancel={() => setPendingDelete(null)} />}
  </Modal>;
}
