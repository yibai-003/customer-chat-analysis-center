# Task Workflow Clarity Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in the current session with test-first verification.

**Goal:** Make the imported Excel task's board ownership, import/analysis lifecycle, and whole-task versus selected-record scope explicit in the analysis workbench.

The sidebar now groups task cards directly under their import-time board, shows board task counts, and keeps the knowledge entry beside each board. The board filter remains available for narrowing the grouped list, but selecting another board never changes the persisted task board or configuration.

**Architecture:** Preserve the existing server-side task binding and `useWorkspaceController` board synchronization. Add presentation helpers for task status/scope, expose the bound configuration version number in the job contract when available, and update the task header, record bulk bar, and task list without changing persistence semantics.

**Tech Stack:** React, TypeScript, Vitest, existing shared `Job` contract and client components.

**Spec:** `E:/客服解析中心工单草稿/issue-task-workflow-clarity.md`

## Global Constraints

- The imported task remains bound to one board, platform, and configuration version.
- The frontend must not replace server-side authorization or task-binding validation.
- Current-page record selection must not be presented as whole-task selection.
- Preserve the existing single-task pause/cancel behavior.
- Do not modify unrelated pre-existing model-pool changes.

### Task 1: Lock the Workbench Scope Language

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/components/AnalysisProgress.tsx`
- Modify: `src/client/components/JobList.tsx`
- Add: `src/client/task-display.ts`
- Test: `src/client/App.test.tsx`

**Interfaces:**
- Consume: existing `Job`, `AnalysisSection`, paged record selection, and import-preview text.
- Produce: visible task context showing board/platform/version, lifecycle state, whole-task pending count, and current-page selection scope.

- [x] **Step 1: Write failing UI assertions**

  Add assertions that:
  - a task header shows board, platform, and configuration version when present;
  - the primary action says `解析全部待处理（N）` for a ready task;
  - the record bulk bar says `已选择当前页 N 条` and does not imply whole-task selection;
  - the task list distinguishes `导入完成，待解析` from `解析中`.

- [x] **Step 2: Run the focused test and verify it fails**

  Run:

  ```powershell
  npm test -- --run src/client/App.test.tsx
  ```

  Expected: the new assertions fail because the current UI only shows the board name and generic `批量解析`.

- [x] **Step 3: Implement the smallest presentation change**

  Add pure status/scope helpers and render them from the existing task header/list and record bulk controls. Keep API calls and task binding unchanged.

- [x] **Step 4: Run focused tests**

  Run:

  ```powershell
  npm test -- --run src/client/App.test.tsx
  npm run typecheck
  ```

  Expected: focused UI tests and type checking pass.

- [x] **Step 5: Run lint and build**

  Run:

  ```powershell
  npm run lint
  npm run build
  ```

  Expected: both commands exit successfully.

### Task 2: Verify the User-Visible Contract

**Files:**
- Test: `src/client/components/ImportPreviewDialog.test.tsx`
- Test: `src/client/components/AnalysisProgress.test.tsx`
- Test: `src/client/App.test.tsx`

- [x] **Step 1: Run the focused component and app tests**

  ```powershell
  npm test -- --run src/client/components/ImportPreviewDialog.test.tsx src/client/components/AnalysisProgress.test.tsx src/client/App.test.tsx
  ```

- [x] **Step 2: Confirm no existing import-preview or progress wording regressed**

  Check the test output for zero failures and ensure the existing preview still shows the selected board, version, platform, pending record count, and historical result count.

- [x] **Step 3: Check the worktree**

  ```powershell
  git status --short
  ```

  Confirm only files belonging to this task are newly modified; preserve the three pre-existing model-pool changes.
