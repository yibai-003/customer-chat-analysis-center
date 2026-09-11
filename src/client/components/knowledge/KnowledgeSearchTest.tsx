import { useEffect, useRef, useState } from "react";
import type { KnowledgeBase, KnowledgeCandidate } from "../../../shared/types";
import type { KnowledgeApiClient } from "../../api/knowledge-api";

export function KnowledgeSearchTest({
  base,
  apiClient,
}: {
  base: KnowledgeBase;
  apiClient: KnowledgeApiClient;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(10);
  const [candidates, setCandidates] = useState<KnowledgeCandidate[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);
  const baseIdRef = useRef(base.id);
  baseIdRef.current = base.id;

  useEffect(() => {
    requestSequence.current += 1;
    setQuery("");
    setCandidates([]);
    setSearched(false);
    setBusy(false);
    setError("");
  }, [base.id]);

  const search = async () => {
    const requestId = ++requestSequence.current;
    const requestedBaseId = base.id;
    setBusy(true);
    setError("");
    try {
      const next = await apiClient.search(requestedBaseId, query, limit);
      if (requestId !== requestSequence.current || baseIdRef.current !== requestedBaseId) return;
      setCandidates(next);
      setSearched(true);
    } catch (caught) {
      if (requestId !== requestSequence.current || baseIdRef.current !== requestedBaseId) return;
      setError(caught instanceof Error ? caught.message : "检索测试失败");
    } finally {
      if (requestId === requestSequence.current && baseIdRef.current === requestedBaseId) {
        setBusy(false);
      }
    }
  };

  return <div className="knowledge-search-view">
    <div className="search-test-input">
      <div><small>LOCAL RETRIEVAL ONLY</small><h2>检索测试</h2>
        <p>输入模拟截图解析结果和辅助字段，只验证当前知识库的本地召回。</p>
      </div>
      <textarea
        aria-label="检索测试输入"
        rows={6}
        placeholder="例如：客户反馈收到商品时外包装破损，要求退款..."
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="search-test-actions">
        <label>候选数量<input
          type="number"
          min={1}
          max={50}
          value={limit}
          onChange={(event) => setLimit(Number(event.target.value))}
        /></label>
        <button className="button dark" disabled={busy || !query.trim()} onClick={search}>
          {busy ? "检索中..." : "开始检索"}
        </button>
      </div>
    </div>

    {error && <div className="form-error">{error}</div>}
    <div className="search-results">
      <div className="search-results-head">
        <span>候选排名</span><strong>{candidates.length} RESULTS</strong>
      </div>
      {candidates.map((candidate, index) => <article
        key={candidate.itemId}
        data-testid="knowledge-candidate"
        className="knowledge-candidate"
      >
        <b>{String(index + 1).padStart(2, "0")}</b>
        <div className="candidate-values">
          {base.columns.filter((column) => column.roles.includes("result")).map((column) => (
            <span key={column.name}><small>{column.name}</small><strong>{candidate.values[column.name] || "空"}</strong></span>
          ))}
        </div>
        <p>{candidate.matchedText}</p>
        <div className="candidate-score">
          <span className="knowledge-state enabled">已启用</span>
          <code>{candidate.score.toFixed(3)}</code>
        </div>
      </article>)}
      {searched && !candidates.length && <div className="knowledge-empty compact">
        <h3>没有召回候选</h3><p>调整输入内容或检查知识库和条目是否启用。</p>
      </div>}
    </div>
  </div>;
}
