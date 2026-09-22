import { useEffect, useState } from "react";
import type { Platform } from "../../../shared/types";
import { api } from "../../api";
import { Modal } from "../Modal";

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function PlatformManagementDialog({ close }: { close: () => void }) {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [editing, setEditing] = useState<Platform | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setPlatforms(await api<Platform[]>("/api/admin/platforms"));
    } catch (loadError) {
      setError(message(loadError, "平台字典加载失败"));
    }
  };

  useEffect(() => { void load(); }, []);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api<Platform>(editing ? `/api/admin/platforms/${editing.id}` : "/api/admin/platforms", {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), code: code.trim() }),
      });
      setName("");
      setCode("");
      setEditing(null);
      setNotice(editing ? "平台已更新" : "平台已创建");
      await load();
    } catch (submitError) {
      setError(message(submitError, "平台保存失败"));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (platform: Platform) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api<Platform>(`/api/admin/platforms/${platform.id}/${platform.isEnabled ? "disable" : "restore"}`, { method: "POST" });
      setNotice(platform.isEnabled ? "平台已停用，新任务不可再选用" : "平台已恢复");
      await load();
    } catch (toggleError) {
      setError(message(toggleError, "平台状态更新失败"));
    } finally {
      setBusy(false);
    }
  };

  return <Modal title="平台字典" subtitle="维护新任务可选的平台名称与全局代码" close={close}>
    {notice && <p className="notice" role="status">{notice}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="admin-create-form">
      <h3>{editing ? "编辑平台" : "新增平台"}</h3>
      <div className="form-grid">
        <label>平台名称<input aria-label="平台名称" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
        <label>平台代码<input aria-label="平台代码" value={code} maxLength={60} onChange={(event) => setCode(event.target.value)} /></label>
      </div>
      <div className="modal-actions">
        {editing && <button type="button" className="button light" disabled={busy} onClick={() => { setEditing(null); setName(""); setCode(""); }}>取消编辑</button>}
        <button type="button" className="button primary" disabled={busy || !name.trim() || !code.trim()} onClick={() => void submit()}>{busy ? "保存中..." : editing ? "保存平台" : "创建平台"}</button>
      </div>
    </div>
    <div className="admin-users-list">
      {platforms.map((platform) => <div className="admin-user-row" key={platform.id}>
        <div className="admin-user-identity"><strong>{platform.name}</strong><span>{platform.code}</span></div>
        <div className={`admin-user-state ${platform.isEnabled ? "enabled" : "disabled"}`}>{platform.isEnabled ? "已启用" : "已停用"}</div>
        <div className="admin-user-actions">
          <button type="button" className="button ghost" disabled={busy} onClick={() => { setEditing(platform); setName(platform.name); setCode(platform.code); }}>编辑</button>
          <button type="button" className="button ghost" disabled={busy} onClick={() => void toggle(platform)}>{platform.isEnabled ? "停用" : "恢复"}</button>
        </div>
      </div>)}
      {!platforms.length && <p className="admin-users-loading">暂无平台，请先创建。</p>}
    </div>
  </Modal>;
}
