// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const baseStyles = readFileSync(resolve(process.cwd(), "src/client/styles.css"), "utf8");
const atelierStyles = readFileSync(resolve(process.cwd(), "src/client/atelier-theme.css"), "utf8");
const workspaceThemePath = resolve(process.cwd(), "src/client/workspace-theme.css");
const workspaceTheme = existsSync(workspaceThemePath) ? readFileSync(workspaceThemePath, "utf8") : "";

function createStyledWorkbench() {
  document.body.dataset.uiTheme = "atelier";
  document.body.innerHTML = `
    <div class="app">
      <header class="topbar"><div class="brand"><strong>客服解析中心</strong></div><div class="user-menu"><button class="user-chip"><span class="user-role">管理员</span></button></div></header>
      <main class="workspace">
        <aside class="sidebar">
          <div class="sidebar-scroll">
            <div class="sidebar-title section-title"><span>解析板块</span></div>
            <div class="job-section-groups">
              <div class="job-section-group">
                <div class="job">
                  <button class="job-select"><strong>接待质检-脱敏数据.xlsx</strong><small>接待流程质检 · 9 条记录 · 已暂停</small>
                    <small class="job-usage">消耗 1.5K Tokens · 4 次调用</small>
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div class="sidebar-system-status"><div class="knowledge-sync-status">知识库已同步</div></div>
          <div class="server-state"><i></i>服务端已连接<b>LOCAL</b></div>
        </aside>
        <section class="content">
          <div class="content-header"><div class="task-heading"><h1>接待质检-脱敏数据.xlsx</h1><p>任务范围：整份 Excel</p></div></div>
          <nav class="record-pager" aria-label="记录分页">
            <label>
              <span>每页</span>
              <div class="select-menu record-page-size-select">
                <button class="select-menu-trigger"><span>50</span><i class="select-menu-caret"></i></button>
              </div>
            </label>
            <output>1-9 / 9</output>
            <button type="button">‹</button>
            <button type="button">›</button>
          </nav>
        </section>
        <aside class="detail">
          <div class="detail-scroll">
            <button class="detail-image-button">
              <figure><img alt="聊天截图" /><figcaption>点击查看原图 ↗</figcaption></figure>
            </button>
          </div>
        </aside>
      </main>
      <button class="button dark">主要操作</button>
      <input aria-label="筛选" />
      <div class="select-menu shared-control-select">
        <button class="select-menu-trigger" type="button">
          <span>全部状态</span><i class="select-menu-caret"></i>
        </button>
      </div>
      <div class="record-main"><img alt="" /></div>
      <section class="knowledge-workspace"><button class="knowledge-tab">知识条目</button></section>
    </div>
    <div class="signin-app">
      <div class="signin-layout">
        <canvas class="signin-dandelion-canvas"></canvas>
      </div>
    </div>`;
  for (const css of [baseStyles, atelierStyles, workspaceTheme]) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
  }
}

function createStyledKnowledgeWorkspace() {
  document.body.dataset.uiTheme = "atelier";
  document.body.innerHTML = `
    <section class="knowledge-workspace">
      <header class="knowledge-topbar">
        <div class="knowledge-brand"><button class="knowledge-back">←</button><span class="brand-mark">知</span><div><small>SECTION KNOWLEDGE WORKSPACE</small><h1>接待流程质检知识库</h1></div></div>
        <div class="knowledge-top-status"><span>0 ACTIVE</span><b>0 ITEMS</b></div>
      </header>
      <nav class="knowledge-tabs">
        <button class="active">内容管理</button><button>知识条目</button><button>检索测试</button>
        <div class="knowledge-base-switch"><label>当前知识库</label><div class="select-menu"><button class="select-menu-trigger">暂无知识库</button></div></div>
      </nav>
      <main class="knowledge-main">
        <div class="knowledge-sync-status">知识快照已生成</div>
        <div class="knowledge-band-head"><div><small>CONTENT MANAGEMENT</small><h2>知识库文件</h2></div><button class="button primary">导入知识库</button></div>
        <div class="knowledge-empty"><b>XLSX</b><h3>当前板块还没有知识库</h3><p>导入 Excel 后配置动态列。</p></div>
        <div class="knowledge-table-scroll"><div class="knowledge-base-row head"><span>知识库</span></div></div>
      </main>
    </section>`;
  for (const css of [baseStyles, atelierStyles, workspaceTheme]) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
  }
}

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  delete document.body.dataset.uiTheme;
});

describe("workbench style contracts", () => {
  it("keeps task names and supporting task details compact and readable", () => {
    createStyledWorkbench();
    const taskName = document.querySelector(".job-select strong")!;
    const taskDetails = document.querySelector(".job-select small")!;
    const usage = document.querySelector(".job-usage")!;

    expect(getComputedStyle(taskName).fontSize).toBe("13px");
    expect(getComputedStyle(taskDetails).fontSize).toBe("12px");
    expect(getComputedStyle(usage).fontSize).toBe("11px");
  });

  it("uses smooth browser interpolation for record thumbnails", () => {
    createStyledWorkbench();
    const thumbnail = document.querySelector(".record-main img")!;

    expect(getComputedStyle(thumbnail).imageRendering).toBe("auto");
  });

  it("aligns the detail image preview frame and caption with the workspace theme", () => {
    createStyledWorkbench();

    expect(workspaceTheme).toMatch(
      /\.detail-image-button figure\s*\{[^}]*border-width: 1px;[^}]*border-color: var\(--workbench-line\);[^}]*border-radius: var\(--workbench-radius-small\);/s,
    );
    expect(workspaceTheme).toMatch(
      /\.detail figure::before,[^}]*\.detail figure::after\s*\{[^}]*border-color: var\(--workbench-blue\);/s,
    );
    expect(workspaceTheme).toMatch(
      /\.detail figcaption\s*\{[^}]*background: var\(--workbench-ink\);[^}]*color: #ffffff;[^}]*font-family: var\(--workbench-font-body\);[^}]*font-size: 11px;[^}]*font-weight: 600;[^}]*letter-spacing: 0;/s,
    );
    expect(workspaceTheme).toMatch(
      /\.detail-image-button:hover figcaption\s*\{[^}]*background: var\(--workbench-accent\);/s,
    );
  });

  it("applies the pale blue workspace palette and shared control treatment to authenticated views only", () => {
    createStyledWorkbench();
    const app = document.querySelector(".app")!;

    expect(getComputedStyle(app).getPropertyValue("--workbench-page").trim()).toBe("#f3f6f8");
    expect(getComputedStyle(app).getPropertyValue("--workbench-panel-tint").trim()).toBe("#edf3f7");
    expect(getComputedStyle(app).getPropertyValue("--workbench-accent").trim()).toBe("#557f9e");
    expect(getComputedStyle(app).getPropertyValue("--workbench-radius").trim()).toBe("12px");
    expect(workspaceTheme).toContain(
      'body[data-ui-theme="atelier"] .app:not(.signin-app) .button',
    );
    expect(workspaceTheme).not.toMatch(
      /(?<!:not\()\.signin-app\b|\.signin-(?:layout|dandelion-canvas)\b/,
    );
    expect(workspaceTheme).toContain(".knowledge-tab");
  });

  it("uses the compact application shell and shared control sizing", () => {
    createStyledWorkbench();
    const app = document.querySelector(".app")!;
    const topbar = app.querySelector(".topbar")!;
    const workspace = app.querySelector(".workspace")!;
    const button = app.querySelector(".button")!;
    const input = app.querySelector("input")!;
    const selectTrigger = app.querySelector(".shared-control-select .select-menu-trigger")!;
    const serverState = app.querySelector(".server-state")!;

    expect(getComputedStyle(app).padding).toBe("8px");
    expect(getComputedStyle(topbar).minHeight).toBe("52px");
    expect(workspaceTheme).toContain("height: 52px;");
    expect(workspaceTheme).toContain(
      "border-radius: var(--workbench-radius) var(--workbench-radius) 0 0;",
    );
    expect(workspaceTheme).toContain(
      "border-radius: 0 0 var(--workbench-radius) var(--workbench-radius);",
    );
    expect(getComputedStyle(workspace).overflow).toBe("hidden");
    expect(getComputedStyle(button).minHeight).toBe("30px");
    expect(getComputedStyle(input).minHeight).toBe("34px");
    expect(selectTrigger).toBeTruthy();
    expect(getComputedStyle(app).getPropertyValue("--workbench-input-height").trim()).toBe("34px");
    expect(workspaceTheme).toMatch(
      /\.select-menu-trigger\s*\{[^}]*min-height: var\(--workbench-input-height\);/s,
    );
    expect(workspaceTheme).toContain("border-radius: 8px !important;");
    expect(getComputedStyle(serverState).fontSize).toBe("10px");
    expect(workspaceTheme).toContain(
      'body[data-ui-theme="atelier"] .app:not(.signin-app) .sidebar',
    );
    expect(workspaceTheme).toContain("grid-template-columns: 248px minmax(0, 1fr)");
    expect(workspaceTheme).toContain("box-shadow: 0 0 0 3px var(--workbench-accent-soft);");
    expect(workspaceTheme).toContain("scrollbar-width: thin");
    expect(workspaceTheme).toContain("--workbench-scrollbar-thumb");
  });

  it("covers overlays, menus, configuration editors, pagination, and task hierarchy", () => {
    expect(workspaceTheme).toContain(".image-preview-panel");
    expect(workspaceTheme).toContain(".top-menu-panel");
    expect(workspaceTheme).toContain(".select-menu-popup");
    expect(workspaceTheme).toContain(".select-menu-option");
    expect(workspaceTheme).toContain(".section-editor");
    expect(workspaceTheme).toContain(".field-editor");
    expect(workspaceTheme).toContain(".record-pager");
    expect(workspaceTheme).toContain(".job-section-heading");
    expect(workspaceTheme).toContain(".job-section-group > .job");
    expect(workspaceTheme).toContain("background: var(--workbench-blue-soft);");
  });

  it("keeps pagination typography quiet and uses a three-level line hierarchy", () => {
    createStyledWorkbench();
    const app = document.querySelector(".app")!;
    const pager = document.querySelector(".record-pager")!;
    const pageSize = document.querySelector(".record-page-size-select")!;
    const pageSizeTrigger = pageSize.querySelector(".select-menu-trigger")!;
    const range = pager.querySelector("output")!;
    const nextButton = Array.from(pager.querySelectorAll(":scope > button")).at(-1)!;

    expect(getComputedStyle(app).getPropertyValue("--workbench-line-subtle").trim()).toBe("#e8eef2");
    expect(getComputedStyle(app).getPropertyValue("--workbench-line").trim()).toBe("#d9e3ea");
    expect(getComputedStyle(app).getPropertyValue("--workbench-line-strong").trim()).toBe("#c5d3dd");
    expect(getComputedStyle(pageSize).width).toBe("54px");
    expect(getComputedStyle(pageSizeTrigger).fontSize).toBe("11px");
    expect(getComputedStyle(pageSizeTrigger).fontWeight).toBe("500");
    expect(getComputedStyle(range).fontSize).toBe("10px");
    expect(getComputedStyle(nextButton).fontSize).toBe("14px");
    expect(workspaceTheme).toMatch(
      /\.record-pager\s*\{[^}]*border-top: 1px solid var\(--workbench-line\);/s,
    );
    expect(workspaceTheme).toMatch(
      /\.knowledge-base-row\s*\{[^}]*border-bottom: 1px solid var\(--workbench-line-subtle\);/s,
    );
    expect(workspaceTheme).toMatch(
      /\.knowledge-item-table :is\(th, td\)\s*\{[^}]*border-bottom: 1px solid var\(--workbench-line-subtle\);/s,
    );
    expect(workspaceTheme).toMatch(
      /\.knowledge-candidate\s*\{[^}]*border-bottom: 1px solid var\(--workbench-line-subtle\);/s,
    );
    expect(workspaceTheme).toMatch(
      /\.knowledge-import-modal \.modal > header\s*\{[^}]*border-bottom: 1px solid var\(--workbench-line-subtle\);/s,
    );
  });

  it("uses the pale-blue role label and usage popover treatment", () => {
    createStyledWorkbench();
    const role = document.querySelector(".user-role")!;

    expect(workspaceTheme).toContain(".user-chip .user-role");
    expect(workspaceTheme).toContain("background: var(--workbench-accent-soft);");
    expect(getComputedStyle(role).color).toBe("var(--workbench-accent)");
    expect(workspaceTheme).toContain(".usage-popover-trigger");
    expect(workspaceTheme).toContain(".usage-popover-panel");
    expect(workspaceTheme).toContain("border: 1px solid #c5d3dd;");
    expect(workspaceTheme).toContain("border-bottom: 1px solid #d9e3ea;");
  });

  it("synchronizes the knowledge workspace with the compact pale-blue shell", () => {
    createStyledKnowledgeWorkspace();
    const workspace = document.querySelector(".knowledge-workspace")!;
    const topbar = document.querySelector(".knowledge-topbar")!;
    const tabs = document.querySelector(".knowledge-tabs")!;
    const activeTab = document.querySelector(".knowledge-tabs > button.active")!;
    const main = document.querySelector(".knowledge-main")!;
    const empty = document.querySelector(".knowledge-empty")!;
    const primary = document.querySelector(".knowledge-band-head .button.primary")!;

    expect(getComputedStyle(workspace).padding).toBe("8px");
    expect(getComputedStyle(workspace).getPropertyValue("--workbench-line-subtle").trim()).toBe(
      "#e8eef2",
    );
    expect(getComputedStyle(workspace).getPropertyValue("--workbench-line").trim()).toBe("#d9e3ea");
    expect(getComputedStyle(workspace).getPropertyValue("--workbench-line-strong").trim()).toBe(
      "#c5d3dd",
    );
    expect(getComputedStyle(topbar).minHeight).toBe("52px");
    expect(getComputedStyle(topbar).boxShadow).toBe("none");
    expect(getComputedStyle(tabs).height).toBe("44px");
    expect(activeTab.classList.contains("active")).toBe(true);
    expect(workspaceTheme).toMatch(
      /\.knowledge-workspace \.knowledge-tabs > button\.active\s*\{[^}]*background: var\(--workbench-accent-soft\);/s,
    );
    expect(getComputedStyle(main).padding).toBe("20px");
    expect(getComputedStyle(empty).minHeight).toBe("280px");
    expect(getComputedStyle(empty).boxShadow).toBe("none");
    expect(primary.classList.contains("primary")).toBe(true);
    expect(workspaceTheme).toMatch(
      /\.knowledge-workspace \.button\.primary\s*\{[^}]*background: var\(--workbench-accent\);/s,
    );
    expect(workspaceTheme).toContain(".knowledge-base-row.head");
    expect(workspaceTheme).toContain("border: 1px dashed var(--workbench-line-strong);");
  });

  it("keeps the task rail hierarchy compact and readable", () => {
    createStyledWorkbench();
    const groups = document.querySelector(".job-section-groups")!;
    groups.innerHTML = `
      <div class="job-section-parent">
        <div class="job-section-parent-label">╰ 聊天问题</div>
        <div class="job-section-group">
          <div class="job-section-heading">
            <button type="button"><span></span>接待流程质检<b>1</b><i></i></button>
            <small class="section-usage">消耗 102K · 34 次</small>
            <button type="button" class="section-knowledge">知</button>
          </div>
          <div class="job active">
            <div class="job-main">
              <button class="job-select"><span class="xls">XLS</span><span><strong>接待质检-脱敏数据2.xlsx</strong><small>接待流程质检 · 9 条记录</small></span></button>
              <button class="usage-popover-trigger job-usage"><span>1.5K Tokens · 4 次调用</span><i>i</i></button>
            </div>
          </div>
          <div class="job-section-empty">当前板块暂无匹配任务</div>
        </div>
      </div>`;

    const parentLabel = document.querySelector(".job-section-parent-label")!;
    const heading = document.querySelector(".job-section-heading")!;
    const boardButton = document.querySelector(".job-section-heading > button:first-child")!;
    const usage = document.querySelector(".section-usage")!;
    const knowledgeButton = document.querySelector(".section-knowledge")!;
    const job = document.querySelector(".job.active")!;
    const jobMain = document.querySelector(".job-main")!;
    const emptyState = document.querySelector(".job-section-empty")!;

    expect(getComputedStyle(parentLabel).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(parentLabel).fontSize).toBe("12px");
    expect(workspaceTheme).toContain("background: var(--workbench-panel-muted);");
    expect(getComputedStyle(heading).minHeight).toBe("38px");
    expect(getComputedStyle(boardButton).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(boardButton).fontSize).toBe("13px");
    expect(getComputedStyle(boardButton).gridColumn).toBe("1");
    expect(getComputedStyle(usage).fontSize).toBe("11px");
    expect(getComputedStyle(usage).gridColumn).toBe("2");
    expect(getComputedStyle(usage).gridRow).toBe("1");
    expect(getComputedStyle(knowledgeButton).gridColumn).toBe("3");
    expect(getComputedStyle(job).minHeight).toBe("44px");
    expect(getComputedStyle(job).boxShadow).toBe("none");
    expect(getComputedStyle(jobMain).display).toBe("grid");
    expect(workspaceTheme).toContain("border-left: 2px solid transparent;");
    expect(workspaceTheme).toContain(
      "height: calc(100dvh - var(--workspace-header-height, 52px) - 16px);",
    );
    expect(workspaceTheme).toContain(
      "body[data-ui-theme=\"atelier\"] .app:not(.signin-app) .job-section-group > .job.active",
    );
    expect(workspaceTheme).toContain("background: var(--workbench-accent-soft);");
    expect(getComputedStyle(emptyState).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(emptyState).fontSize).toBe("12px");
    expect(workspaceTheme).toContain("font-variant-numeric: tabular-nums;");
  });

  it("uses the pale-blue workbench surfaces for the empty import state", () => {
    createStyledWorkbench();
    const content = document.querySelector(".content")!;
    content.insertAdjacentHTML(
      "beforeend",
      `<div class="blank">
        <div class="upload-art"><b>XLSX</b><i>+</i></div>
        <h2>把聊天记录带进来</h2><p>支持带嵌入图片和辅助字段的 .xlsx 文件</p>
        <button class="button primary large">选择文件</button>
      </div>`,
    );
    const blank = document.querySelector(".blank")!;
    const upload = document.querySelector(".upload-art")!;
    const uploadBadge = document.querySelector(".upload-art i")!;

    expect(getComputedStyle(blank).border).toBe("1px dashed var(--workbench-line-strong)");
    expect(getComputedStyle(upload).border).toBe("1px solid var(--workbench-line-strong)");
    expect(getComputedStyle(upload).boxShadow).toBe("none");
    expect(workspaceTheme).toContain("background: var(--workbench-accent);");
    expect(uploadBadge).toBeTruthy();
    expect(workspaceTheme).toMatch(
      /\.app:not\(\.signin-app\) \.blank\s*\{[^}]*border: 1px dashed var\(--workbench-line-strong\);[^}]*background: var\(--workbench-panel\);/s,
    );
    expect(workspaceTheme).toMatch(
      /\.app:not\(\.signin-app\) \.upload-art\s*\{[^}]*background: var\(--workbench-blue-soft\);[^}]*box-shadow: none;/s,
    );
  });

  it("aligns import selection and delete confirmation dialog details with the workbench theme", () => {
    createStyledWorkbench();
    document.querySelector(".app")!.insertAdjacentHTML(
      "beforeend",
      `<div class="backdrop import-section-modal"><div class="modal">
        <div class="import-preview-summary"><strong>接待质检.xlsx</strong></div>
      </div></div>
      <div class="backdrop confirm-action-modal"><div class="modal">
        <div class="confirm-dialog"><span class="confirm-icon danger">!</span><p>确认删除此文件吗？</p></div>
      </div></div>`,
    );
    const importSummary = document.querySelector(".import-section-modal .import-preview-summary")!;
    const confirmDialog = document.querySelector(".confirm-action-modal .confirm-dialog")!;
    const confirmIcon = document.querySelector(".confirm-action-modal .confirm-icon.danger")!;

    expect(importSummary).toBeTruthy();
    expect(confirmDialog).toBeTruthy();
    expect(confirmIcon).toBeTruthy();
    expect(workspaceTheme).toMatch(
      /\.import-section-modal \.import-preview-summary\s*\{[^}]*border-left: 2px solid var\(--workbench-accent\);[^}]*background: var\(--workbench-panel-tint\);/s,
    );
    expect(workspaceTheme).toMatch(
      /\.confirm-action-modal \.confirm-dialog\s*\{[^}]*color: var\(--workbench-ink\);/s,
    );
    expect(workspaceTheme).toMatch(
      /\.confirm-action-modal \.confirm-icon\.danger\s*\{[^}]*background: var\(--workbench-danger-soft\);[^}]*color: var\(--workbench-danger\);/s,
    );
  });
});
