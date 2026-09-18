import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { UserProfile, UserRole } from "../../../shared/types";
import { api } from "../../api";
import { Modal } from "../Modal";
import { ConfirmDialog } from "../ConfirmDialog";

export const USER_ROLE_ORDER: UserRole[] = ["admin", "config", "operator", "reviewer", "readonly"];

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  admin: "管理员",
  config: "配置人员",
  operator: "操作人员",
  reviewer: "审核人员",
  readonly: "只读人员",
};

const USERNAME_PATTERN = /^[\w.\-@]+$/;

export function validateNewUsername(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 100) return "用户名长度必须为 1-100 个字符";
  if (!USERNAME_PATTERN.test(trimmed)) return "用户名只能包含字母、数字、下划线、点、短横线、@";
  return null;
}

export function validateNewDisplayName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 100) return "显示名称长度必须为 1-100 个字符";
  return null;
}

export function validateNewPassword(value: string): string | null {
  if (value.length < 8 || value.length > 512) return "密码长度必须为 8-512 个字符";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return "密码包含不支持的字符";
  }
  return null;
}

interface CreateForm {
  username: string;
  displayName: string;
  password: string;
  role: UserRole;
}

const EMPTY_CREATE: CreateForm = { username: "", displayName: "", password: "", role: "operator" };
const EMPTY_RESET = { password: "", confirm: "" };

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatUpdatedAt(value: string) {
  return value.replace("T", " ").slice(0, 16);
}

export function UserManagementDialog({ close }: { close: () => void }) {
  const mounted = useRef(true);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [rowError, setRowError] = useState("");

  const [createForm, setCreateForm] = useState<CreateForm>(EMPTY_CREATE);
  const [createError, setCreateError] = useState("");
  const [creating, setCreating] = useState(false);

  const [editing, setEditing] = useState<{ id: string; displayName: string; role: UserRole } | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDisable, setPendingDisable] = useState<UserProfile | null>(null);

  const [resetTarget, setResetTarget] = useState<UserProfile | null>(null);
  const [resetForm, setResetForm] = useState(EMPTY_RESET);
  const [resetError, setResetError] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [pendingResetConfirm, setPendingResetConfirm] = useState(false);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const list = await api<UserProfile[]>("/api/admin/users");
      if (mounted.current) setUsers(list);
    } catch (error) {
      if (mounted.current) setLoadError(errorMessage(error, "账号列表加载失败"));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  const closeDialog = () => {
    setCreateForm((current) => ({ ...current, password: "" }));
    setResetForm(EMPTY_RESET);
    close();
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (creating) return;
    const validation = validateNewUsername(createForm.username)
      ?? validateNewPassword(createForm.password)
      ?? validateNewDisplayName(createForm.displayName);
    if (validation) { setCreateError(validation); return; }
    setCreating(true);
    setCreateError("");
    setNotice("");
    try {
      await api<UserProfile>("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: createForm.username.trim(),
          displayName: createForm.displayName.trim(),
          password: createForm.password,
          role: createForm.role,
        }),
      });
      if (!mounted.current) return;
      setCreateForm(EMPTY_CREATE);
      setNotice("账号已创建");
      await load();
    } catch (error) {
      if (mounted.current) setCreateError(errorMessage(error, "创建账号失败"));
    } finally {
      if (mounted.current) setCreating(false);
    }
  };

  const saveEdit = async () => {
    if (!editing || savingEdit) return;
    const validation = validateNewDisplayName(editing.displayName);
    if (validation) { setRowError(validation); return; }
    setSavingEdit(true);
    setRowError("");
    setNotice("");
    try {
      await api<UserProfile>(`/api/admin/users/${editing.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: editing.displayName.trim(), role: editing.role }),
      });
      if (!mounted.current) return;
      setEditing(null);
      setNotice("账号已更新");
      await load();
    } catch (error) {
      if (!mounted.current) return;
      setRowError(errorMessage(error, "更新账号失败"));
      // 以服务端为准刷新，避免界面停留在未生效的修改上。
      await load();
    } finally {
      if (mounted.current) setSavingEdit(false);
    }
  };

  const toggleEnabled = async (user: UserProfile, enabled: boolean) => {
    if (busyId) return;
    setBusyId(user.id);
    setRowError("");
    setNotice("");
    try {
      await api<UserProfile>(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isEnabled: enabled }),
      });
      if (!mounted.current) return;
      setNotice(enabled ? "账号已启用" : "账号已停用，既有会话已撤销");
      await load();
    } catch (error) {
      if (!mounted.current) return;
      setRowError(errorMessage(error, enabled ? "启用账号失败" : "停用账号失败"));
      await load();
    } finally {
      if (mounted.current) setBusyId(null);
    }
  };

  const openReset = (user: UserProfile) => {
    setResetTarget(user);
    setResetForm(EMPTY_RESET);
    setResetError("");
    setRowError("");
  };

  const cancelReset = () => {
    setResetForm(EMPTY_RESET);
    setResetTarget(null);
    setResetError("");
  };

  const requestReset = () => {
    if (!resetTarget || resetBusy) return;
    const validation = validateNewPassword(resetForm.password)
      ?? (resetForm.password !== resetForm.confirm ? "两次输入的密码不一致" : null);
    if (validation) { setResetError(validation); return; }
    setResetError("");
    setPendingResetConfirm(true);
  };

  const confirmReset = async () => {
    const target = resetTarget;
    if (!target || resetBusy) return;
    const password = resetForm.password;
    setPendingResetConfirm(false);
    setResetBusy(true);
    try {
      await api<UserProfile>(`/api/admin/users/${target.id}/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!mounted.current) return;
      setResetForm(EMPTY_RESET);
      setResetTarget(null);
      setNotice("密码已重置，该账号既有会话已撤销");
      await load();
    } catch (error) {
      if (mounted.current) setResetError(errorMessage(error, "重置密码失败"));
    } finally {
      if (mounted.current) setResetBusy(false);
    }
  };

  return <>
    <Modal title="账号管理" subtitle="PIXEL OPERATIONS / ACCESS CONTROL" close={closeDialog} className="admin-users-modal">
      {loading ? <p className="admin-users-loading">正在加载账号…</p> : loadError
        ? <div className="form-error" role="alert">{loadError}</div>
        : <>
          {notice && <div className="notice" role="status">{notice}</div>}
          {rowError && <div className="form-error" role="alert">{rowError}</div>}
          <div className="admin-users-list">
            {users.map((user) => {
              const editState = editing?.id === user.id ? editing : null;
              return <div className="admin-user-row" key={user.id}>
                <div className="admin-user-identity">
                  <strong>{user.username}</strong>
                  {editState
                    ? <input aria-label={`显示名称 ${user.username}`} value={editState.displayName} maxLength={100} onChange={(event) => setEditing({ ...editState, displayName: event.target.value })} />
                    : <span>{user.displayName}</span>}
                  <small>更新于 {formatUpdatedAt(user.updatedAt)}</small>
                </div>
                <div className="admin-user-role">
                  {editState
                    ? <select aria-label={`角色 ${user.username}`} value={editState.role} onChange={(event) => setEditing({ ...editState, role: event.target.value as UserRole })}>
                      {USER_ROLE_ORDER.map((role) => <option value={role} key={role}>{USER_ROLE_LABELS[role]}</option>)}
                    </select>
                    : <span className={`admin-role ${user.role}`}>{USER_ROLE_LABELS[user.role]}</span>}
                </div>
                <div className={`admin-user-state ${user.isEnabled ? "enabled" : "disabled"}`}>{user.isEnabled ? "已启用" : "已停用"}</div>
                <div className="admin-user-actions">
                  {editState
                    ? <>
                      <button type="button" className="button light" disabled={savingEdit} onClick={() => void saveEdit()}>{savingEdit ? "保存中…" : "保存"}</button>
                      <button type="button" className="button ghost" disabled={savingEdit} onClick={() => setEditing(null)}>取消</button>
                    </>
                    : <>
                      <button type="button" className="button ghost" onClick={() => { setRowError(""); setNotice(""); setEditing({ id: user.id, displayName: user.displayName, role: user.role }); }}>编辑</button>
                      <button type="button" className="button ghost" disabled={busyId === user.id} onClick={() => user.isEnabled ? setPendingDisable(user) : void toggleEnabled(user, true)}>{user.isEnabled ? "停用" : "启用"}</button>
                      <button type="button" className="button ghost" onClick={() => openReset(user)}>重置密码</button>
                    </>}
                </div>
              </div>;
            })}
            {!users.length && <p className="admin-users-loading">暂无账号</p>}
          </div>

          {resetTarget && <section className="admin-reset-panel" aria-label={`重置 ${resetTarget.username} 的密码`}>
            <h3>重置“{resetTarget.username}”的密码</h3>
            <div className="admin-reset-fields">
              <label><span>新密码（至少 8 位）</span>
                <input type="password" aria-label="新密码" autoComplete="new-password" value={resetForm.password} onChange={(event) => setResetForm({ ...resetForm, password: event.target.value })} />
              </label>
              <label><span>确认新密码</span>
                <input type="password" aria-label="确认新密码" autoComplete="new-password" value={resetForm.confirm} onChange={(event) => setResetForm({ ...resetForm, confirm: event.target.value })} />
              </label>
            </div>
            {resetError && <div className="form-error" role="alert">{resetError}</div>}
            <div className="admin-reset-actions">
              <button type="button" className="button light" disabled={resetBusy} onClick={cancelReset}>取消</button>
              <button type="button" className="button dark" disabled={resetBusy} onClick={requestReset}>{resetBusy ? "重置中…" : "确认重置"}</button>
            </div>
          </section>}

          <form className="admin-create-form" onSubmit={submitCreate}>
            <h3>创建账号</h3>
            <div className="form-grid">
              <label>账号<input aria-label="账号" value={createForm.username} maxLength={100} autoComplete="off" onChange={(event) => setCreateForm({ ...createForm, username: event.target.value })} /></label>
              <label>显示名称<input aria-label="显示名称" value={createForm.displayName} maxLength={100} autoComplete="off" onChange={(event) => setCreateForm({ ...createForm, displayName: event.target.value })} /></label>
              <label>初始密码（至少 8 位）<input type="password" aria-label="初始密码" value={createForm.password} autoComplete="new-password" onChange={(event) => setCreateForm({ ...createForm, password: event.target.value })} /></label>
              <label>角色<select aria-label="角色" value={createForm.role} onChange={(event) => setCreateForm({ ...createForm, role: event.target.value as UserRole })}>
                {USER_ROLE_ORDER.map((role) => <option value={role} key={role}>{USER_ROLE_LABELS[role]}</option>)}
              </select></label>
            </div>
            {createError && <div className="form-error" role="alert">{createError}</div>}
            <div className="modal-actions"><button type="submit" className="button primary" disabled={creating}>{creating ? "创建中…" : "创建账号"}</button></div>
          </form>
        </>}
    </Modal>
    {pendingDisable && <ConfirmDialog
      title="停用账号"
      message={`确认停用“${pendingDisable.username}”吗？该账号的既有会话会立即失效。`}
      confirmLabel="确认停用"
      onConfirm={() => { const target = pendingDisable; setPendingDisable(null); void toggleEnabled(target, false); }}
      onCancel={() => setPendingDisable(null)}
    />}
    {pendingResetConfirm && resetTarget && <ConfirmDialog
      title="重置密码"
      message={`确认重置“${resetTarget.username}”的密码吗？该账号的既有会话会立即失效。`}
      confirmLabel="确认重置"
      onConfirm={() => void confirmReset()}
      onCancel={() => setPendingResetConfirm(false)}
    />}
  </>;
}