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
      <header class="topbar"><div class="brand"><strong>客服解析中心</strong></div></header>
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
        </section>
        <aside class="detail"><div class="detail-scroll"></div></aside>
      </main>
      <button class="button dark">主要操作</button>
      <input aria-label="筛选" />
      <select aria-label="状态"><option>全部状态</option></select>
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

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  delete document.body.dataset.uiTheme;
});

describe("workbench style contracts", () => {
  it("keeps task names and supporting task details readable", () => {
    createStyledWorkbench();
    const taskName = document.querySelector(".job-select strong")!;
    const taskDetails = document.querySelector(".job-select small")!;
    const usage = document.querySelector(".job-usage")!;

    expect(getComputedStyle(taskName).fontSize).toBe("14px");
    expect(getComputedStyle(taskDetails).fontSize).toBe("12px");
    expect(getComputedStyle(usage).fontSize).toBe("12px");
  });

  it("uses smooth browser interpolation for record thumbnails", () => {
    createStyledWorkbench();
    const thumbnail = document.querySelector(".record-main img")!;

    expect(getComputedStyle(thumbnail).imageRendering).toBe("auto");
  });

  it("applies the B palette and shared control treatment to authenticated views only", () => {
    createStyledWorkbench();
    const app = document.querySelector(".app")!;

    expect(getComputedStyle(app).getPropertyValue("--workbench-page").trim()).toBe("#f3f6f8");
    expect(getComputedStyle(app).getPropertyValue("--workbench-blue-strong").trim()).toBe("#557f9e");
    expect(workspaceTheme).toContain(
      'body[data-ui-theme="atelier"] .app:not(.signin-app) .button',
    );
    expect(workspaceTheme).not.toMatch(
      /(?<!:not\()\.signin-app\b|\.signin-(?:layout|dandelion-canvas)\b/,
    );
    expect(workspaceTheme).toContain("border-radius: 4px !important;");
    expect(workspaceTheme).toContain(".knowledge-tab");
  });

  it("keeps workbench typography, control sizing, and rail proportions consistent", () => {
    createStyledWorkbench();
    const app = document.querySelector(".app")!;
    const heading = app.querySelector(".content-header h1")!;
    const select = app.querySelector("select");
    const serverState = app.querySelector(".server-state")!;

    expect(workspaceTheme).toContain("font-size: clamp(24px, 2.15vw, 32px)");
    expect(getComputedStyle(heading).lineHeight).toBe("1.2");
    expect(getComputedStyle(select!).minHeight).toBe("36px");
    expect(getComputedStyle(serverState).fontSize).toBe("10px");
    expect(workspaceTheme).toContain(
      'body[data-ui-theme="atelier"] .app:not(.signin-app) .sidebar',
    );
    expect(workspaceTheme).toContain("background: var(--workbench-panel-tint);");
    expect(workspaceTheme).toContain("scrollbar-width: thin");
    expect(workspaceTheme).toContain("--workbench-scrollbar-thumb");
  });

  it("covers overlays, menus, configuration editors, pagination, and task hierarchy", () => {
    expect(workspaceTheme).toContain(".image-preview-panel");
    expect(workspaceTheme).toContain(".top-menu-panel");
    expect(workspaceTheme).toContain(".section-editor");
    expect(workspaceTheme).toContain(".field-editor");
    expect(workspaceTheme).toContain(".record-pager");
    expect(workspaceTheme).toContain(".job-section-heading");
    expect(workspaceTheme).toContain(".job-section-group > .job");
    expect(workspaceTheme).toContain("background: var(--workbench-blue-soft);");
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
            <button class="job-select"><strong>接待质检-脱敏数据2.xlsx</strong><small>接待流程质检 · 9 条记录</small></button>
          </div>
          <div class="job-section-empty">当前板块暂无匹配任务</div>
        </div>
      </div>`;

    const parentLabel = document.querySelector(".job-section-parent-label")!;
    const heading = document.querySelector(".job-section-heading")!;
    const boardButton = document.querySelector(".job-section-heading > button:first-child")!;
    const usage = document.querySelector(".section-usage")!;
    const knowledgeButton = document.querySelector(".section-knowledge")!;
    const emptyState = document.querySelector(".job-section-empty")!;

    expect(getComputedStyle(parentLabel).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(parentLabel).fontSize).toBe("12px");
    expect(getComputedStyle(heading).backgroundColor).toBe("rgb(220, 233, 241)");
    expect(getComputedStyle(boardButton).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(boardButton).fontSize).toBe("14px");
    expect(getComputedStyle(boardButton).gridColumn).toBe("1");
    expect(getComputedStyle(usage).fontSize).toBe("12px");
    expect(getComputedStyle(usage).gridColumn).toBe("1 / -1");
    expect(getComputedStyle(knowledgeButton).gridColumn).toBe("2");
    expect(workspaceTheme).toContain(
      "body[data-ui-theme=\"atelier\"] .app:not(.signin-app) .job-section-group > .job.active",
    );
    expect(workspaceTheme).toContain("background: var(--workbench-blue-soft);");
    expect(workspaceTheme).toContain("background: var(--workbench-blue-soft);");
    expect(getComputedStyle(emptyState).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(emptyState).fontSize).toBe("12px");
    expect(workspaceTheme).toContain("font-variant-numeric: tabular-nums;");
  });
});
