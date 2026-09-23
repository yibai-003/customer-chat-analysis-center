import { useEffect, useRef, useState, type MouseEvent } from "react";
import { BotanicalArt, ArtworkCredits } from "./components/BotanicalArt";
import type { AnalysisField, AnalysisSection, RecordDetail } from "../shared/types";
import { AnalysisProgress } from "./components/AnalysisProgress";
import { AnalysisRunDialog } from "./components/AnalysisRunDialog";
import { JobList } from "./components/JobList";
import { ImagePreviewDialog } from "./components/ImagePreviewDialog";
import { ImportPreviewDialog } from "./components/ImportPreviewDialog";
import { ImportSectionDialog } from "./components/ImportSectionDialog";
import { ImportProgressDialog } from "./components/ImportProgressDialog";
import { KnowledgeWorkspace } from "./components/knowledge/KnowledgeWorkspace";
import { ModelConfigDialog } from "./components/ModelConfigDialog";
import { RecordPager } from "./components/RecordPager";
import { SectionConfigDialog } from "./components/SectionConfigDialog";
import { UserManagementDialog } from "./components/admin/UserManagementDialog";
import { AuditLogDialog } from "./components/admin/AuditLogDialog";
import { BackupManagementDialog } from "./components/admin/BackupManagementDialog";
import { PlatformManagementDialog } from "./components/admin/PlatformManagementDialog";
import { useWorkspaceController } from "./hooks/useWorkspaceController";
import { useRecordSelection } from "./hooks/useRecordSelection";
import { KnowledgeSyncStatus } from "./components/KnowledgeSyncStatus";
import { useSession } from "./auth/useSession";
import { SignIn } from "./auth/SignIn";
import { logoutRequest } from "./auth/auth-api";
import { sessionCan, setSession, subscribeAccessDenied, type CurrentSession } from "./auth/session";
import type { UserCapability } from "../shared/types";
import {
  StructuredResultView,
  structuredItems,
  type StructuredResultViewConfig,
} from "./components/StructuredResultView";

const roleLabels: Record<string, string> = {
  admin: "管理员",
  config: "配置人员",
  operator: "操作人员",
  reviewer: "审核人员",
  readonly: "只读人员",
};

async function signOut() {
  try {
    await logoutRequest();
  } catch {
    // The session may already be expired server-side; local sign-out still applies.
  }
  setSession(null);
}

const lostDealResultView: StructuredResultViewConfig = {
  className: "lost-deal-attribution",
  ariaLabel: "未成交归因摘要",
  title: "未成交归因摘要",
  sections: [
    { label: "客户原因", items: (parsed) => structuredItems(parsed.customerReasons) },
    { label: "客服原因", items: (parsed) => structuredItems(parsed.serviceReasons) },
    { label: "需求类型", items: (parsed) => structuredItems(parsed.demandTypes) },
  ],
  detail: {
    label: "具体需求",
    fallback: "未提取",
    value: (parsed) => typeof parsed.specificDemand === "string" ? parsed.specificDemand : "",
  },
  evidence: (parsed) => Array.isArray(parsed.evidence)
    ? parsed.evidence.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [],
  evidenceFallback: "无明确未成交依据",
  confidence: (parsed) => typeof parsed.confidence === "number" ? parsed.confidence : Number(parsed.confidence),
  confidenceFallback: "未提供",
  reviewRequired: (parsed) => parsed.reviewRequired === true,
  statusLabels: { review: "待复核", ok: "已归因" },
  warning: "证据不足或置信度偏低，请人工复核后再作为结论使用。",
  listFallback: "无明确依据",
};

const labels: Record<string, string> = {
  pending: "待解析", processing: "解析中", completed: "已完成",
  failed: "失败", needs_review: "需复核", confirmed: "已确认",
};

export default function App() {
  const session = useSession();
  if (session.status === "loading") {
    return (
      <div className="app signin-app">
        <main className="signin"><div className="signin-loading">正在恢复会话...</div></main>
      </div>
    );
  }
  if (session.status === "signedOut") {
    return <SignIn hasAdmin={session.hasAdmin} />;
  }
  return <Workspace session={session.session} />;
}

function Workspace({ session }: { session: CurrentSession }) {
  const user = session.user;
  const can = (capability: UserCapability) => sessionCan(session, capability);
  const [detailOpen, setDetailOpen] = useState(false);
  const [isDetailDrawerViewport, setIsDetailDrawerViewport] = useState(() => (
    typeof window !== "undefined"
      ? window.matchMedia?.("(max-width: 1199px)").matches ?? window.innerWidth <= 1199
      : false
  ));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [topMenu, setTopMenu] = useState<"management" | "user" | null>(null);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const detailPanelRef = useRef<HTMLElement | null>(null);
  const restoreDetailFocusRef = useRef(false);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restorePreviewFocusRef = useRef(false);
  const topMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const topMenuRef = useRef<HTMLDivElement | null>(null);
  const {
    headerRef,
    headerHeight,
    jobs,
    job,
    recordPage,
    page,
    pageSize,
    selected,
    sections,
    platforms,
    activeFields,
    activeSection,
    setActiveSection,
    models,
    dialog,
    setDialog,
    filter,
    busy,
    notice,
    setNotice,
    knowledgeSection,
    setKnowledgeSection,
    previewImage,
    setPreviewImage,
    taskActionBusy,
    importPreview,
    setImportPreview,
    pendingImportFile,
    setPendingImportFile,
    selectingImportFile,
    setSelectingImportFile,
    refreshing,
    importJobId,
    setImportJobId,
    analysisCapacity,
    setAnalysisCapacity,
    currentSection,
    refresh,
    navigateToJob,
    changeRecordPage,
    changePageSize,
    changeFilter,
    importFile,
    previewImport,
    commitImport,
    handleImportCompleted,
    analyzeRecord,
    requestBatchAnalysis,
    pendingTargetedCount,
    targetedSummary,
    startBatchAnalysis,
    retryField,
    saveReview,
    handleJobsDeleted,
    taskAction,
    refreshProgress,
    requestRecordDetail,
    clearSelectedRecord,
    editSelectedRecord,
  } = useWorkspaceController({ canManageConfig: can("config:manage") });
  const selection = useRecordSelection({ jobId: job?.id, sectionId: currentSection?.id, filter });
  const detailDrawerOpen = isDetailDrawerViewport && detailOpen && Boolean(selected);
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 1199px)");
    if (!media) {
      const onResize = () => setIsDetailDrawerViewport(window.innerWidth <= 1199);
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }
    const onChange = (event: MediaQueryListEvent) => {
      if (!event.matches && detailPanelRef.current?.contains(document.activeElement)) {
        restoreDetailFocusRef.current = true;
      }
      setIsDetailDrawerViewport(event.matches);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    document.body.classList.toggle("detail-drawer-active", detailDrawerOpen);
    if (!detailDrawerOpen || previewImage) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        restoreDetailFocusRef.current = true;
        setDetailOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const panel = detailPanelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(
        "button, textarea, input, select, a[href], [tabindex]:not([tabindex='-1'])",
      )].filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("detail-drawer-active");
    };
  }, [detailDrawerOpen, previewImage]);
  useEffect(() => {
    if (!detailDrawerOpen) return;
    detailPanelRef.current?.querySelector<HTMLButtonElement>(".detail-close")?.focus();
  }, [detailDrawerOpen, selected?.id]);
  useEffect(() => {
    if (detailDrawerOpen || !restoreDetailFocusRef.current) return;
    restoreDetailFocusRef.current = false;
    if (detailTriggerRef.current?.isConnected) detailTriggerRef.current.focus();
  }, [detailDrawerOpen]);
  useEffect(() => {
    if (previewImage || !restorePreviewFocusRef.current) return;
    restorePreviewFocusRef.current = false;
    if (previewTriggerRef.current?.isConnected) previewTriggerRef.current.focus();
  }, [previewImage]);
  const closeDetail = () => {
    restoreDetailFocusRef.current = true;
    setDetailOpen(false);
  };
  const openRecord = async (event: MouseEvent<HTMLButtonElement>, recordId: string) => {
    detailTriggerRef.current = event.currentTarget;
    if (!job) return;
    setDetailOpen(false);
    clearSelectedRecord();
    if (await requestRecordDetail(recordId, job.id, { explicit: true })) setDetailOpen(true);
  };
  const openPreviewImage = (src: string, alt: string, trigger: HTMLButtonElement) => {
    previewTriggerRef.current = trigger;
    setPreviewImage({ src, alt });
  };
  const closePreviewImage = () => {
    restorePreviewFocusRef.current = true;
    setPreviewImage(null);
  };
  const hasManagementAccess = ["config:manage", "user:manage", "audit:view", "backup:manage"]
    .some((capability) => can(capability as UserCapability));
  const closeTopMenu = (restoreFocus = true) => {
    setTopMenu(null);
    if (restoreFocus) topMenuTriggerRef.current?.focus();
  };
  const toggleTopMenu = (menu: "management" | "user", event: MouseEvent<HTMLButtonElement>) => {
    topMenuTriggerRef.current = event.currentTarget;
    setTopMenu((current) => current === menu ? null : menu);
  };
  useEffect(() => {
    if (!topMenu) return;
    const onPointerDown = (event: globalThis.MouseEvent) => {
      if (!topMenuRef.current?.contains(event.target as Node)) closeTopMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeTopMenu();
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [topMenu]);
  useEffect(() => {
    if (targetedSummary && targetedSummary.skipped > 0) selection.clear();
  }, [targetedSummary]);
  useEffect(() => subscribeAccessDenied((message) => {
    setDialog(null);
    setKnowledgeSection(null);
    setAnalysisCapacity(null);
    setImportPreview(null);
    setPendingImportFile(null);
    setSelectingImportFile(null);
    setNotice(message);
  }), []);
  if (knowledgeSection && can("config:manage")) {
    return <KnowledgeWorkspace
      section={knowledgeSection}
      onBack={() => setKnowledgeSection(null)}
    />;
  }

  return (
    <div className="app" style={{ "--workspace-header-height": `${headerHeight}px`, "--sidebar-width": sidebarCollapsed ? "76px" : "240px" } as import("react").CSSProperties}>
      <header className="topbar" ref={headerRef} inert={detailDrawerOpen || Boolean(previewImage)}>
        <div className="brand"><span className="brand-mark">析</span><div><strong>客服解析中心</strong><small>CHAT INTELLIGENCE WORKSPACE</small></div></div>
        <div className="top-actions">
          <button type="button" className="button light task-action-tertiary" aria-label="刷新进度" disabled={!job || refreshing || busy || taskActionBusy || Boolean(importJobId)} onClick={() => void refreshProgress()}>{refreshing ? "刷新中..." : "刷新进度"}</button>
          {can("task:import") && <label className="button primary task-action-primary">＋ 导入 Excel<input hidden type="file" accept=".xlsx" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) importFile(file); }} /></label>}
          {can("task:export") && <button type="button" className="button export task-action-secondary" aria-label="导出结果" disabled={!job || !currentSection} onClick={() => job && currentSection && (window.location.href = `/api/jobs/${job.id}/export`)}>导出结果 ↗</button>}
          <div className="top-menu-cluster" ref={topMenuRef}>
            {hasManagementAccess && <div className="top-menu">
              <button
                type="button"
                className="button top-menu-trigger"
                aria-label={topMenu === "management" ? "关闭管理菜单" : "打开管理菜单"}
                aria-expanded={topMenu === "management"}
                aria-haspopup="menu"
                onClick={(event) => toggleTopMenu("management", event)}
              >
                管理 <span aria-hidden="true">⌄</span>
              </button>
              {topMenu === "management" && <div className="top-menu-panel" role="menu" aria-label="管理操作">
                {can("config:manage") && <button type="button" role="menuitem" onClick={() => { closeTopMenu(false); setDialog("section"); }}>板块配置</button>}
                {can("config:manage") && <button type="button" role="menuitem" onClick={() => { closeTopMenu(false); setDialog("platforms"); }}>平台字典</button>}
                {can("config:manage") && <button type="button" role="menuitem" onClick={() => { closeTopMenu(false); setDialog("model"); }}>模型配置</button>}
                {can("user:manage") && <button type="button" role="menuitem" onClick={() => { closeTopMenu(false); setDialog("users"); }}>账号管理</button>}
                {can("audit:view") && <button type="button" role="menuitem" onClick={() => { closeTopMenu(false); setDialog("audit"); }}>审计日志</button>}
                {can("backup:manage") && <button type="button" role="menuitem" onClick={() => { closeTopMenu(false); setDialog("backups"); }}>备份管理</button>}
              </div>}
            </div>}
            <div className="top-menu user-menu">
              <button
                type="button"
                className="user-chip"
                aria-label={topMenu === "user" ? "关闭用户菜单" : "打开用户菜单"}
                aria-expanded={topMenu === "user"}
                aria-haspopup="menu"
                onClick={(event) => toggleTopMenu("user", event)}
              >
                <span className="user-name">{user.displayName}</span>
                <span className="user-role">{roleLabels[user.role] ?? user.role}</span>
                <span className="user-menu-caret" aria-hidden="true">⌄</span>
              </button>
              {topMenu === "user" && <div className="top-menu-panel user-menu-panel" role="menu" aria-label="用户操作">
                <div className="user-menu-summary"><strong>{user.displayName}</strong><span>{roleLabels[user.role] ?? user.role}</span></div>
                <button type="button" role="menuitem" onClick={() => { closeTopMenu(false); void signOut(); }}>退出</button>
              </div>}
            </div>
          </div>
        </div>
      </header>

      <main className="workspace" inert={Boolean(previewImage)}>
        <aside className={`sidebar ${sidebarCollapsed ? "is-collapsed" : ""}`} inert={detailDrawerOpen}>
          <div className="sidebar-scroll">
          <div className="sidebar-title">
            <span>解析任务</span>
            <div className="sidebar-title-actions">
              <b>{String(jobs.length).padStart(2, "0")}</b>
              <button
                type="button"
                className="sidebar-toggle"
                aria-label={sidebarCollapsed ? "展开任务侧栏" : "折叠任务侧栏"}
                aria-expanded={!sidebarCollapsed}
                title={sidebarCollapsed ? "展开任务侧栏" : "折叠任务侧栏"}
                onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              >
                {sidebarCollapsed ? "→" : "←"}
              </button>
            </div>
          </div>
          {!jobs.length ? <div className="side-empty">导入 Excel 文件<br />建立解析任务</div> : <JobList jobs={jobs} sections={sections} selectedId={job?.id} canDelete={can("task:delete")} onSelect={(id) => void navigateToJob(id).catch((error) => setNotice(error instanceof Error ? error.message : "切换任务失败"))} onDeleted={handleJobsDeleted} />}
          <div className="sidebar-title section-title"><span>解析板块</span>{can("config:manage") && <button onClick={() => setDialog("section")}>管理</button>}</div>
          <nav>{sections.filter((s) => !s.parentId).map((parent) => <div className="section-group" key={parent.id}><div className="parent">╰ {parent.name}</div>{sections.filter((s) => s.parentId === parent.id).map((child) => <div className={`section-entry ${activeSection === child.id ? "active" : ""}`} key={child.id}><button className="section-select" disabled={Boolean(job?.sectionId && job.sectionId !== child.id)} title={job?.sectionId && job.sectionId !== child.id ? "当前任务已绑定其他解析板块" : undefined} onClick={() => setActiveSection(child.id)}><span />{child.name}<i /></button>{can("config:manage") && <button className="section-knowledge" aria-label={`打开${child.name}知识库`} title="知识库" onClick={() => setKnowledgeSection(child)}>知</button>}</div>)}</div>)}</nav>
          </div>
          <div className="sidebar-system-status"><KnowledgeSyncStatus canRetry={can("config:manage")} /></div>
          <div className="sidebar-botanical"><BotanicalArt variant="specimen" /><ArtworkCredits /></div>
          <div className="server-state"><i />服务端已连接 <b>LOCAL</b></div>
        </aside>

        <section className="content" inert={detailDrawerOpen}>
          <div className="content-header">
            <div className="task-heading"><BotanicalArt variant="specimen" /><small>解析队列</small><h1>{job?.originalFilename ?? "等待导入解析文件"}</h1><p>{job ? `共 ${job.totalRecords} 条记录，当前板块：${currentSection?.name}` : "导入包含聊天截图的 Excel，开始客服分析"}</p>{job && <AnalysisProgress job={job} />}</div>
            {job && <div className="content-actions"><select aria-label="按记录状态筛选" value={filter} onChange={(e) => void changeFilter(e.target.value)}><option value="all">全部状态</option><option value="pending">待解析</option><option value="completed">已完成</option><option value="needs_review">需复核</option><option value="failed">失败</option></select>{can("task:analyze") && job.status === "processing" && <><button className="button light" disabled={taskActionBusy} onClick={() => taskAction("pause")}>暂停</button><button className="button light" disabled={taskActionBusy} onClick={() => taskAction("cancel")}>取消</button></>}{can("task:analyze") && job.status === "failed" && <button className="button light" disabled={taskActionBusy} onClick={() => taskAction("retry-failed")}>重试失败</button>}{can("task:analyze") && <button className="button dark" disabled={busy || taskActionBusy || job.status === "processing" || job.status === "cancelled"} onClick={() => void requestBatchAnalysis()}>{busy ? "解析中..." : job.status === "paused" ? "继续解析 →" : "批量解析 →"}</button>}</div>}
          </div>
          {notice && <div className="notice">{notice}</div>}
          {!job ? <div className="blank"><div className="upload-art"><b>XLSX</b><i>＋</i></div><h2>把聊天记录带进来</h2><p>支持带嵌入图片和辅助字段的 .xlsx 文件</p>{can("task:import") && <label className="button primary large">选择文件<input hidden type="file" accept=".xlsx" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) importFile(file); }} /></label>}</div> :
            <div className="record-list">
              <div className={`list-head ${can("task:analyze") ? "" : "list-head-without-selection"}`}>{can("task:analyze") && <label className="record-check"><input type="checkbox" aria-label="全选本页记录" checked={recordPage.items.length > 0 && recordPage.items.every((record) => selection.selectedIds.includes(record.id))} onChange={() => selection.togglePage(recordPage.items.map((record) => record.id))} /></label>}<span>记录</span><span>来源字段</span><span>解析状态</span><span>复核</span><span>操作</span></div>
              {can("task:analyze") && <div className="record-bulk-bar">
                <span>{selection.selectedIds.length ? `已选择 ${selection.selectedIds.length} 条` : "未选择记录"}</span>
                <button type="button" disabled={!selection.selectedIds.length || busy || taskActionBusy || job.status === "processing" || job.status === "cancelled"} onClick={() => void requestBatchAnalysis(selection.selectedIds)}>解析已选</button>
                {selection.selectedIds.length > 0 && <button type="button" disabled={busy} onClick={selection.clear}>清空选择</button>}
              </div>}
              {recordPage.items.map((record) => {
                const checked = selection.selectedIds.includes(record.id);
                return <div key={record.id} className={`record ${can("task:analyze") ? "" : "record-without-selection"} ${selected?.id === record.id ? "active" : ""}`}>
                  {can("task:analyze") && <label className="record-check"><input type="checkbox" aria-label={`选择记录 ${record.rowNumber}`} checked={checked} onChange={() => selection.toggle(record.id)} /></label>}
                  <button className="record-select" onClick={(event) => void openRecord(event, record.id)}>
                    <span className="record-main"><img src={record.imageUrl} alt="" loading="lazy" decoding="async" /><span><strong>记录 {String(record.rowNumber).padStart(2, "0")}</strong><small>{record.sheetName} · 第 {record.rowNumber} 行</small></span></span>
                    <span className="field-tags">{Object.entries(record.sourceFields).slice(0, 2).map(([key, value]) => <em key={key}>{key}: {value || "空"}</em>)}</span>
                    <span className={`status ${record.status}`}><i />{labels[record.status]}</span>
                    <span className={`review ${record.reviewStatus}`}>{labels[record.reviewStatus] ?? "未复核"}</span><span className="view">查看 →</span>
                  </button>
                </div>;
              })}
              {!recordPage.items.length && <div className="no-results">当前筛选下没有记录</div>}
              <RecordPager
                page={page}
                pageSize={pageSize}
                total={recordPage.total}
                onPageChange={(nextPage) => void changeRecordPage(nextPage)}
                onPageSizeChange={(nextPageSize) => void changePageSize(nextPageSize)}
              />
            </div>}
        </section>

        {detailDrawerOpen && <button type="button" className="detail-drawer-backdrop" aria-label="关闭记录详情" onClick={closeDetail} />}
        <aside
          ref={detailPanelRef}
          className={`detail ${detailDrawerOpen ? "detail-drawer-open" : ""}`}
          role={isDetailDrawerViewport ? "dialog" : "complementary"}
          aria-label="记录详情"
          aria-modal={detailDrawerOpen || undefined}
          aria-hidden={isDetailDrawerViewport && !detailDrawerOpen ? true : undefined}
          inert={isDetailDrawerViewport && !detailDrawerOpen}
        >
          {selected ? <Detail record={selected} section={currentSection} fields={activeFields} busy={busy || job?.status === "processing"} canAnalyze={can("task:analyze")} canReview={can("review:save")} setRecord={editSelectedRecord} onAnalyze={() => void analyzeRecord(selected.id)} onRetry={retryField} onSave={saveReview} onPreviewImage={openPreviewImage} onClose={closeDetail} /> : <div className="detail-empty"><BotanicalArt variant="specimen" /><h2>选择一条记录</h2><p>查看原图、辅助字段和 AI 解析结果</p></div>}
        </aside>
      </main>

      {dialog === "model" && <ModelConfigDialog models={models} close={() => setDialog(null)} saved={() => { setDialog(null); refresh(); }} />}
      {dialog === "section" && <SectionConfigDialog sections={sections} close={() => setDialog(null)} saved={() => { setDialog(null); refresh(); }} />}
      {dialog === "platforms" && <PlatformManagementDialog close={() => { setDialog(null); void refresh(); }} />}
      {dialog === "users" && <UserManagementDialog close={() => setDialog(null)} />}
      {dialog === "audit" && <AuditLogDialog close={() => setDialog(null)} />}
      {dialog === "backups" && <BackupManagementDialog close={() => setDialog(null)} />}
      {analysisCapacity && <AnalysisRunDialog
        capacity={analysisCapacity}
        selectedCount={pendingTargetedCount}
        onCancel={() => setAnalysisCapacity(null)}
        onConfirm={(options) => void startBatchAnalysis({
          concurrency: options.concurrency,
          batchSize: options.batchSize,
          maxPaidTokens: options.maxPaidTokens,
        })}
      />}
      {previewImage && <ImagePreviewDialog {...previewImage} onClose={closePreviewImage} />}
      {selectingImportFile && <ImportSectionDialog file={selectingImportFile} sections={sections} platforms={platforms} busy={busy} error={notice} onCancel={() => setSelectingImportFile(null)} onConfirm={(sectionId, platformId) => void previewImport(selectingImportFile, sectionId, platformId)} />}
      {importPreview && pendingImportFile && <ImportPreviewDialog preview={importPreview} busy={busy} onCancel={() => { const file = pendingImportFile; setImportPreview(null); setPendingImportFile(null); setSelectingImportFile(file); }} onConfirm={async () => { const file = pendingImportFile; const sectionId = importPreview.sectionId; const platformId = importPreview.platformId; if (!sectionId || !platformId) return; setImportPreview(null); setPendingImportFile(null); await commitImport(file, sectionId, platformId); }} />}
      {importJobId && <ImportProgressDialog importJobId={importJobId} onCompleted={handleImportCompleted} onClose={() => setImportJobId(null)} />}
    </div>
  );
}

export function formatFieldResult(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

export function Detail({ record, section, fields, setRecord, onAnalyze, onRetry, onSave, busy, canAnalyze = true, canReview = true, onPreviewImage = () => undefined, onClose }: { record: RecordDetail; section?: AnalysisSection; fields: AnalysisField[]; setRecord: (r: RecordDetail) => void; onAnalyze: () => void; onRetry: (fieldKey: string) => void; onSave: () => void; busy: boolean; canAnalyze?: boolean; canReview?: boolean; onPreviewImage?: (src: string, alt: string, trigger: HTMLButtonElement) => void; onClose?: () => void }) {
  const run = section && record.analysisRuns.find((item) => item.sectionId === section.id);
  const fieldRuns = section ? record.fieldRuns.filter((item) => item.sectionId === section.id) : [];
  const latestFieldRuns = fieldRuns.filter((item, index) => (
    fieldRuns.findIndex((candidate) => candidate.fieldId === item.fieldId) === index
  ));
  const displayFields: AnalysisField[] = (fields.length ? fields : (section?.outputSchema ?? []).map((field, index) => ({ ...field, id: field.key, sectionId: section?.id ?? "", prompt: section?.prompt ?? "", required: Boolean(field.required), imageEnabled: section?.imageEnabled !== false, dependsOn: [], sortOrder: index, isEnabled: true, exportEnabled: true }))).filter((field) => field.exportEnabled !== false);
  const attributionRun = latestFieldRuns.find((item) => item.fieldKey === "未成交归因" && (item.status === "completed" || item.status === "needs_review"));
  const attributionValue = attributionRun?.result?.["未成交归因"];
  const runtimeResult = latestFieldRuns.length ? Object.assign({}, ...latestFieldRuns.slice().reverse().filter((item) => item.status === "completed" || item.status === "needs_review").map((item) => item.result)) : run?.result ?? {};
  const currentReview = section ? record.sectionReviews?.[section.id] : undefined;
  const result = Object.fromEntries(displayFields.map((field) => [
    field.key,
    currentReview?.humanResult && field.key in currentReview.humanResult
      ? currentReview.humanResult[field.key]
      : !currentReview && record.humanResult && field.key in record.humanResult
        ? record.humanResult[field.key]
      : runtimeResult[field.key],
  ]));
  const change = (key: string, value: string) => {
    const nextResult = { ...result, [key]: value };
    setRecord({
      ...record,
      humanResult: nextResult,
      sectionReviews: section
        ? { ...record.sectionReviews, [section.id]: { humanResult: nextResult, reviewStatus: currentReview?.reviewStatus ?? "pending", reviewNote: currentReview?.reviewNote ?? record.reviewNote } }
        : record.sectionReviews,
    });
  };
  const changeNote = (value: string) => setRecord({
    ...record,
    reviewNote: value,
    sectionReviews: section
      ? { ...record.sectionReviews, [section.id]: { humanResult: currentReview?.humanResult ?? result, reviewStatus: currentReview?.reviewStatus ?? "pending", reviewNote: value } }
      : record.sectionReviews,
  });
  return <div className="detail-shell">
    <div className="detail-scroll">
      <div className="detail-head">
      <div><small>RECORD {String(record.rowNumber).padStart(2, "0")}</small><h2>{section?.name ?? "解析详情"}</h2></div>
      <div className="detail-head-actions">
        <span className={`status ${record.status}`}><i />{labels[record.status]}</span>
        {onClose && <button type="button" className="detail-close" aria-label="关闭记录详情" title="关闭" onClick={onClose}>×</button>}
      </div>
    </div>
    <div className="detail-context">
      <button type="button" className="detail-image-button" aria-label="打开聊天截图预览" title="打开大图" onClick={(event) => onPreviewImage(record.imageUrl, `记录 ${String(record.rowNumber).padStart(2, "0")} 聊天截图`, event.currentTarget)}>
        <figure><img src={record.imageUrl} alt={`记录 ${String(record.rowNumber).padStart(2, "0")} 聊天截图`} loading="eager" decoding="async" /><figcaption>点击查看原图 ↗</figcaption></figure>
      </button>
      <details className="detail-sources" key={record.id}>
        <summary>辅助字段 <span>{Object.keys(record.sourceFields).length} 项 · 展开查看</span></summary>
        <div className="source-fields-grid">{Object.entries(record.sourceFields).map(([key, value]) => <div className="source-field" key={key}><span>{key}</span><strong>{value || "未填写"}</strong></div>)}</div>
      </details>
    </div>
    <div className="detail-block detail-results">
      <h3>字段解析结果 <span>{fieldRuns.length ? `· ${fieldRuns.length} 次字段运行` : run ? `· ${run.createdAt.slice(11, 16)}` : ""}</span></h3>
      {Boolean(attributionValue) && <StructuredResultView config={lostDealResultView} value={attributionValue} />}
      <div className="result-fields-grid">{displayFields.map((field) => {
        const fieldRun = fieldRuns.find((item) => item.fieldKey === field.key);
        const retryable = fieldRun && ["failed", "needs_review", "skipped"].includes(fieldRun.status);
        const value = formatFieldResult(result[field.key]);
        const wide = field.type === "object" || value.length > 160 || field.imageEnabled;
        return <label className={`result-field${wide ? " result-field--wide" : ""}`} key={field.key}>
          <span>{field.label} <em className={`field-status ${fieldRun?.status ?? "pending"}`}>{labels[fieldRun?.status ?? "pending"] ?? "待解析"}</em>{canAnalyze && retryable && <button type="button" className="field-retry" disabled={busy} onClick={() => onRetry(field.key)}>重试</button>}</span>
          <textarea rows={wide ? 6 : field.type === "string" ? 2 : 1} value={value} readOnly={!canReview} onChange={(e) => change(field.key, e.target.value)} />
          {fieldRun?.evidence && <small className="field-evidence">依据：{fieldRun.evidence}</small>}
          {fieldRun?.errorMessage && <small className="form-error" role="alert">{fieldRun.errorMessage}</small>}
        </label>;
      })}</div>
    </div>
      <label className="result-field"><span>复核备注</span><textarea rows={2} value={currentReview?.reviewNote ?? record.reviewNote} readOnly={!canReview} onChange={(e) => changeNote(e.target.value)} /></label>
    </div>
    {(canAnalyze || canReview) && <div className="detail-actions">{canAnalyze && <button className="button dark" disabled={busy} onClick={onAnalyze}>{fieldRuns.length ? "重新解析 →" : "开始解析 →"}</button>}{canReview && <button className="button light" disabled={busy} onClick={onSave}>保存复核</button>}</div>}
  </div>;
}
