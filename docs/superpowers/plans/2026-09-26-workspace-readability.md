# Workspace Readability Implementation Plan

> **For agentic workers:** Implement against GitHub Issue #5. Preserve all existing worktree changes and do not commit or push.

**Goal:** Improve workbench text readability, screenshot scaling, and narrow-screen usability without changing business workflows.

**Architecture:** Keep the change in the existing client presentation layer. Add a small CSS contract test for the most important visual requirements, then update the base screenshot rule and the Atelier-scoped workbench styles.

**Tech Stack:** React, TypeScript, CSS, Vitest, T3 collaborative preview.

**Spec:** GitHub Issue #5, `[UX] 提升工作台文字可读性、截图清晰度与窄屏适配`.

## Global Constraints

- Preserve the existing Atelier / pixel visual language and current task, permission, and review behavior.
- Do not change server code, persistence, APIs, model usage, or runtime dependencies.
- Keep primary workbench text at 14px or larger and ordinary supporting text at 12px or larger.
- Preserve the complete screenshot in detail view; only the list thumbnail interpolation changes.
- Verify at 1280px, 1024px, and 390px viewport widths.
- Do not commit, push, or alter unrelated dirty files.

---

### Task 1: Record the style contract

**Files:**
- Create: `src/client/workspace-style-contracts.test.ts`
- Modify: `src/client/components/JobList.test.tsx`
- Modify: `docs/superpowers/plans/2026-09-26-workspace-readability.md`

**Interfaces:**
- Consumes: The two existing CSS files loaded by `src/client/main.tsx`.
- Produces: Regression assertions for task-name size, support-text size, screenshot interpolation, and complete filename access.

- [x] **Step 1: Add failing assertions** for the rendered task title tooltip and computed task/support text sizes plus thumbnail `image-rendering`.
- [x] **Step 2: Run the focused test** and confirm it fails because the current CSS uses undersized text and pixelated scaling.
- [x] **Step 3: Keep the tests limited** to user-facing task-label and style contracts; do not add a general CSS framework or dependency.

### Task 2: Improve task-list labels and workbench styles

**Files:**
- Modify: `src/client/components/JobList.tsx`
- Modify: `src/client/components/JobList.test.tsx`
- Modify: `src/client/styles.css`
- Modify: `src/client/atelier-theme.css`
- Test: `src/client/workspace-style-contracts.test.ts`

**Interfaces:**
- Consumes: Existing job and record markup, current responsive breakpoints, and existing theme tokens.
- Produces: Readable task/record labels, full task filename available on hover, smooth screenshot thumbnails, and responsive workbench spacing.

- [x] **Step 1: Add the task filename title** to the task-name element and a rendering regression test.
- [x] **Step 2: Raise key workbench labels** (task name, board, usage, progress, record metadata, list headers) to the Issue's stated font-size floor while keeping only low-priority technical tags smaller.
- [x] **Step 3: Keep task filenames compact** with single-line ellipsis in the sidebar and preserve the full filename with a native title tooltip.
- [x] **Step 4: Remove pixelated screenshot upscaling** in the base and Atelier-scoped rules while keeping thumbnail dimensions stable.
- [x] **Step 5: Adjust existing 1199px, 1050px, and 700px layouts** only where needed to prevent overlap and maintain usable controls.
- [x] **Step 6: Run the focused tests**, inspect computed styles, and visually inspect the workbench at all three required viewport widths.

### Task 3: Verify the change

**Files:**
- No additional files.

**Interfaces:**
- Consumes: The updated client presentation and style-contract tests.
- Produces: Local verification evidence for Issue #5.

- [x] **Step 1: Run** `npm test -- src/client`.
- [x] **Step 2: Run** `npm run typecheck`, `npm run lint`, and `npm run build`.
- [x] **Step 3: Inspect** the 1280px, 1024px, and 390px layouts in the T3 preview and record any manual limitation.
- [x] **Step 4: Review** `git status --short` and confirm no unrelated change was discarded or staged.
