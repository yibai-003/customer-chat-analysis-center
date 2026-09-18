import { useCallback, useEffect, useRef, useState } from "react";
import type { BackupCreation, BackupEntry, RestoreCopy, RestoreVerification } from "../../../shared/types";
import { api } from "../../api";
import { Modal } from "../Modal";
import { ConfirmDialog } from "../ConfirmDialog";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatTime(value: string | null) {
  return value ? value.replace("T", " ").slice(0, 19) : "时间未知";
}

const CHECK_LABELS: Record<string, string> = {
  "restored-marker": "恢复标记",
  database: "数据库完整性与版本",
  "file-references": "引用文件",
  "knowledge-catalog": "知识快照",
  "model-credentials": "密钥可用性",
};

export function BackupManagementDialog({ close }: { close: () => void }) {
  const mounted = useRef(true);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);

  const [restoreTarget, setRestoreTarget] = useState<BackupEntry | null>(null);
  const [targetDir, setTargetDir] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [pendingRestoreConfirm, setPendingRestoreConfirm] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreCopy | null>(null);

  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState("");
  const [verification, setVerification] = useState<RestoreVerification | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    setError("");
    try {
      const list = await api<BackupEntry[]>("/api/admin/backups");
      if (mounted.current) setBackups(list);
    } catch (loadError) {
      if (mounted.current) setError(errorMessage(loadError, "备份列表加载失败"));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createBackup = async () => {
    if (creating) return;
    setCreating(true);
    setError("");
    setNotice("");
    setVerification(null);
    try {
      const created = await api<BackupCreation>("/api/admin/backups", { method: "POST" });
      if (!mounted.current) return;
      setNotice(`备份包已生成（仅生成备份，未影响运行数据）：${created.name}`);
      await load();
    } catch (createError) {
      if (mounted.current) setError(errorMessage(createError, "创建备份失败"));
    } finally {
      if (mounted.current) setCreating(false);
    }
  };

  const openRestore = (backup: BackupEntry) => {
    setRestoreTarget(backup);
    setTargetDir("");
    setRestoreError("");
    setNotice("");
    setVerifyError("");
    setVerification(null);
  };

  const cancelRestore = () => {
    setRestoreTarget(null);
    setTargetDir("");
    setRestoreError("");
  };

  const requestRestore = () => {
    if (!restoreTarget || restoring) return;
    if (!targetDir.trim()) { setRestoreError("请填写一个新的恢复目录（绝对路径）"); return; }
    setRestoreError("");
    setPendingRestoreConfirm(true);
  };

  const confirmRestore = async () => {
    const backup = restoreTarget;
    if (!backup || restoring) return;
    setPendingRestoreConfirm(false);
    setRestoring(true);
    setRestoreError("");
    try {
      const result = await api<RestoreCopy>("/api/admin/backups/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: backup.name, targetDir: targetDir.trim() }),
      });
      if (!mounted.current) return;
      setRestoreResult(result);
      setRestoreTarget(null);
      setTargetDir("");
      setNotice("恢复副本已生成（尚未切换运行数据）");
    } catch (restoreFailure) {
      if (mounted.current) setRestoreError(errorMessage(restoreFailure, "恢复失败"));
    } finally {
      if (mounted.current) setRestoring(false);
    }
  };

  const verifyRestore = async () => {
    if (!restoreResult || verifying) return;
    setVerifying(true);
    setVerifyError("");
    try {
      const result = await api<RestoreVerification>("/api/admin/backups/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetDir: restoreResult.directory }),
      });
      if (!mounted.current) return;
      setVerification(result);
      setNotice(result.ok ? "恢复副本验证通过" : "恢复副本验证未通过");
    } catch (verifyFailure) {
      if (mounted.current) setVerifyError(errorMessage(verifyFailure, "验证恢复副本失败"));
    } finally {
      if (mounted.current) setVerifying(false);
    }
  };

  return <>
    <Modal title="备份管理" subtitle="PIXEL OPERATIONS / BACKUP & RESTORE" close={close} className="backup-manage-modal">
      {notice && <div className="notice" role="status">{notice}</div>}
      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="backup-toolbar">
        <p>备份包含数据库、上传与图片、导出结果和知识快照；加密密钥需单独保管。</p>
        <button type="button" className="button dark" disabled={creating} onClick={() => void createBackup()}>{creating ? "备份中…" : "创建备份"}</button>
      </div>

      <div className="backup-list">
        {loading ? <p className="backup-empty">正在加载备份…</p> : backups.map((backup) => <div className="backup-row" key={backup.name}>
          <div className="backup-identity">
            <strong>{backup.name}</strong>
            <small>{formatTime(backup.createdAt)} · {backup.valid ? "校验通过" : "未通过校验"}</small>
          </div>
          <span className={`backup-valid ${backup.valid ? "ok" : "bad"}`}>{backup.valid ? "可用" : "不可用"}</span>
          <button type="button" className="button ghost" disabled={!backup.valid || restoring} onClick={() => openRestore(backup)}>恢复到新目录</button>
        </div>)}
        {!loading && !backups.length && <p className="backup-empty">暂无备份包</p>}
      </div>

      {restoreTarget && <section className="restore-panel" aria-label={`恢复 ${restoreTarget.name}`}>
        <h3>把“{restoreTarget.name}”恢复到新目录</h3>
        <label>新目录（绝对路径，必须不存在且不在运行数据目录内）
          <input aria-label="恢复目录" value={targetDir} placeholder="例如 D:\\recovery-20260917" onChange={(event) => setTargetDir(event.target.value)} />
        </label>
        {restoreError && <div className="form-error" role="alert">{restoreError}</div>}
        <div className="modal-actions">
          <button type="button" className="button light" disabled={restoring} onClick={cancelRestore}>取消</button>
          <button type="button" className="button dark" disabled={restoring} onClick={requestRestore}>{restoring ? "恢复中…" : "确认恢复"}</button>
        </div>
      </section>}

      {restoreResult && <section className="restore-result" aria-label="恢复副本">
        <h3>恢复副本已生成（尚未切换运行数据）</h3>
        <p>目录：<code>{restoreResult.directory}</code></p>
        <p className="restore-note">切换运行数据由主机侧人工执行；本页面不会覆盖当前环境。</p>
        <button type="button" className="button light" disabled={verifying} onClick={() => void verifyRestore()}>{verifying ? "验证中…" : "验证恢复副本"}</button>
        {verifyError && <div className="form-error" role="alert">{verifyError}</div>}
        {verification && <div className="verify-result">
          <h4>{verification.ok ? "恢复副本验证通过" : "恢复副本验证未通过"}</h4>
          <ul>{verification.checks.map((check) => <li key={check.name} className={check.ok ? "ok" : "bad"}>
            <span>{check.ok ? "通过" : "失败"}</span> {CHECK_LABELS[check.name] ?? check.name}
          </li>)}</ul>
        </div>}
      </section>}
    </Modal>
    {pendingRestoreConfirm && restoreTarget && <ConfirmDialog
      title="恢复到新目录"
      message={`将把“${restoreTarget.name}”恢复到 ${targetDir.trim()}。不会覆盖当前运行数据，也不代表已切换生产环境。`}
      confirmLabel="确认生成恢复副本"
      onConfirm={() => void confirmRestore()}
      onCancel={() => setPendingRestoreConfirm(false)}
    />}
  </>;
}