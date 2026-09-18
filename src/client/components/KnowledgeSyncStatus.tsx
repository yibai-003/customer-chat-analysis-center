import { useEffect, useRef, useState } from "react";
import { api } from "../api";

interface SyncStatus { state: "synced" | "pending" | "conflict"; snapshotReady: boolean; github: "not_checked" }
export function KnowledgeSyncStatus({ canRetry = true }: { canRetry?: boolean }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const mounted = useRef(true);
  const busy = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const current = generation.current;
      try {
        if (busy.current) return;
        const next = await api<SyncStatus>("/api/knowledge-sync", { signal: controller.signal });
        if (!controller.signal.aborted && current === generation.current) { setStatus(next); setError(""); }
      } catch { if (!controller.signal.aborted && current === generation.current) setError("无法读取知识快照状态"); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 5000); }
    };
    void poll();
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer); };
  }, []);
  const retry = async () => {
    if (busy.current) return;
    busy.current = true; generation.current++;
    setRetrying(true); setError("");
    try { const next = await api<SyncStatus>("/api/knowledge-sync/retry", { method: "POST" }); if (mounted.current) setStatus(next); }
    catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : "快照重试失败"); }
    finally { busy.current = false; if (mounted.current) setRetrying(false); }
  };
  return <div className="knowledge-sync-status" role="status" style={{ padding: "12px 0", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
    {status?.state === "synced" ? "知识快照已生成；GitHub 推送状态未检查。"
      : status?.state === "conflict" ? "知识快照存在仓库冲突，请保留本地数据并合并配置。"
      : status?.state === "pending" ? "本地修改已保存，知识快照等待同步。" : error ? "知识快照状态未知。" : "正在读取知识快照状态…"}
    {error && <span role="alert"> {error}</span>}
    {canRetry && <button className="button light" disabled={retrying || status?.state === "conflict"} onClick={() => void retry()}>
      {retrying ? "同步中…" : "重试快照同步"}
    </button>}
  </div>;
}
