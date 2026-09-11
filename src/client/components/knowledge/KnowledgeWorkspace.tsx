import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { AnalysisSection, KnowledgeBase } from "../../../shared/types";
import { knowledgeApi } from "../../api/knowledge-api";
import type { KnowledgeApiClient } from "../../api/knowledge-api";
import { KnowledgeBaseList } from "./KnowledgeBaseList";
import { KnowledgeImportDialog } from "./KnowledgeImportDialog";
import { KnowledgeItemList } from "./KnowledgeItemList";
import { KnowledgeSearchTest } from "./KnowledgeSearchTest";

type KnowledgeTab = "content" | "items" | "search";
const knowledgeTabs: Array<[KnowledgeTab, string]> = [
  ["content", "内容管理"],
  ["items", "知识条目"],
  ["search", "检索测试"],
];

export function KnowledgeWorkspace({
  section,
  onBack,
  apiClient = knowledgeApi,
}: {
  section: AnalysisSection;
  onBack: () => void;
  apiClient?: KnowledgeApiClient;
}) {
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [tab, setTab] = useState<KnowledgeTab>("content");
  const [importTarget, setImportTarget] = useState<KnowledgeBase | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const loadBases = async (preferredId?: string) => {
    setLoading(true);
    setError("");
    try {
      const next = await apiClient.listBases(section.id);
      setBases(next);
      setSelectedId((current) => {
        const target = preferredId ?? current;
        return next.some((base) => base.id === target) ? target : next[0]?.id;
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加载知识库失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setTab("content");
    setSelectedId(undefined);
    void loadBases();
  }, [section.id]);

  const selectedBase = bases.find((base) => base.id === selectedId);
  const selectBase = (base: KnowledgeBase) => {
    setSelectedId(base.id);
    setTab("items");
  };

  const activateTab = (index: number) => {
    const nextIndex = (index + knowledgeTabs.length) % knowledgeTabs.length;
    setTab(knowledgeTabs[nextIndex][0]);
    tabRefs.current[nextIndex]?.focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      activateTab(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      activateTab(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      activateTab(0);
    } else if (event.key === "End") {
      event.preventDefault();
      activateTab(knowledgeTabs.length - 1);
    }
  };

  return <div className="knowledge-workspace">
    <header className="knowledge-topbar">
      <div className="knowledge-brand">
        <button aria-label="返回解析工作区" className="knowledge-back" onClick={onBack}>←</button>
        <span className="brand-mark">知</span>
        <div><small>SECTION KNOWLEDGE WORKSPACE</small>
          <h1>{section.name}知识库</h1>
        </div>
      </div>
      <div className="knowledge-top-status">
        <span>{bases.filter((base) => base.isEnabled).length} ACTIVE</span>
        <b>{bases.reduce((sum, base) => sum + base.itemCount, 0)} ITEMS</b>
      </div>
    </header>

    <nav className="knowledge-tabs" aria-label="知识库工作区" role="tablist">
      {knowledgeTabs.map(([value, label], index) => <button
        key={value}
        ref={(element) => { tabRefs.current[index] = element; }}
        id={`knowledge-tab-${value}`}
        role="tab"
        aria-selected={tab === value}
        aria-controls={`knowledge-panel-${value}`}
        tabIndex={tab === value ? 0 : -1}
        className={tab === value ? "active" : ""}
        onClick={() => setTab(value)}
        onKeyDown={(event) => handleTabKeyDown(event, index)}
      >{label}</button>)}
      <div className="knowledge-base-switch" role="presentation">
        <label>当前知识库</label>
        <select
          aria-label="当前知识库"
          value={selectedId ?? ""}
          onChange={(event) => setSelectedId(event.target.value || undefined)}
        >
          {!bases.length && <option value="">暂无知识库</option>}
          {bases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
        </select>
      </div>
    </nav>

    <main className="knowledge-main">
      {notice && <div className="notice">{notice}</div>}
      {error && <div className="form-error">{error}</div>}
      <section
        id="knowledge-panel-content"
        role="tabpanel"
        aria-labelledby="knowledge-tab-content"
        hidden={tab !== "content"}
        className="knowledge-tabpanel"
      >
      {tab === "content" && (loading ? <div className="knowledge-loading">正在同步板块知识库...</div> : <KnowledgeBaseList
          sectionId={section.id}
          bases={bases}
          selectedId={selectedId}
          apiClient={apiClient}
          onSelect={selectBase}
          onImport={() => setImportTarget(null)}
          onReimport={(base) => setImportTarget(base)}
          onChanged={() => loadBases()}
        />)}
      </section>
      <section
        id="knowledge-panel-items"
        role="tabpanel"
        aria-labelledby="knowledge-tab-items"
        hidden={tab !== "items"}
        className="knowledge-tabpanel"
      >
        {tab === "items" && (loading
          ? <div className="knowledge-loading">正在同步板块知识库...</div>
          : selectedBase
          ? <KnowledgeItemList
            base={selectedBase}
            apiClient={apiClient}
            onBaseCountChanged={() => loadBases(selectedBase.id)}
          />
          : <NoBase onImport={() => setImportTarget(null)} />)}
      </section>
      <section
        id="knowledge-panel-search"
        role="tabpanel"
        aria-labelledby="knowledge-tab-search"
        hidden={tab !== "search"}
        className="knowledge-tabpanel"
      >
        {tab === "search" && (loading
          ? <div className="knowledge-loading">正在同步板块知识库...</div>
          : selectedBase
          ? <KnowledgeSearchTest base={selectedBase} apiClient={apiClient} />
          : <NoBase onImport={() => setImportTarget(null)} />)}
      </section>
    </main>

    {importTarget !== undefined && <KnowledgeImportDialog
      sectionId={section.id}
      targetBase={importTarget ?? undefined}
      apiClient={apiClient}
      onClose={() => setImportTarget(undefined)}
      onImported={(result) => {
        setImportTarget(undefined);
        setNotice(`导入完成：新增 ${result.added}，更新 ${result.updated}，跳过 ${result.skipped}`);
        void loadBases(result.knowledgeBase.id);
      }}
    />}
  </div>;
}

function NoBase({ onImport }: { onImport: () => void }) {
  return <div className="knowledge-empty">
    <b>00</b><h3>请先导入知识库</h3>
    <p>知识条目和检索测试需要一个当前知识库。</p>
    <button className="button primary" onClick={onImport}>导入知识库</button>
  </div>;
}
