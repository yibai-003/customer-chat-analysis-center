# Batch Pause and Resume Implementation Plan

> **Issue:** GitHub #2, https://github.com/yibai-003/customer-chat-analysis-center/issues/2
> **Spec:** `E:/客服解析中心工单草稿/issue-batch-task-controls.md`
> **Related guide:** `docs/guides/cancellation-and-model-budget.md`

**Goal:** Let operators select multiple analysis tasks, pause tasks that are currently processing, and resume tasks that are paused, with an outcome for every task.

**Constraints:** Preserve the existing pause contract (finish in-flight records, then stop claiming new records); resume through the existing run-lock and bound section configuration; enforce authorization server-side; do not add batch cancel, delete, or migration behavior.

### Task 1: Add Batch Control Service and API

**Files:**
- Add: `src/server/services/batch-task-control-service.ts`
- Add: `src/server/services/batch-task-control-service.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/services/batch-analysis-service.test.ts` or route tests
- Modify: `src/server/auth/authorization.test.ts`
- Modify: `src/shared/types.ts`

- [x] Write failing service/API tests for full success, mixed states, partial failures, duplicates, maximum selection size, and unauthorized access.
- [x] Verify the focused tests fail for the intended missing behavior.
- [x] Implement bounded input validation and per-task results with understandable skipped/failed reasons.
- [x] Pause via the existing repository pause operation. Resume via the existing analysis runner using each job's bound section, and isolate each item's failure.
- [x] Verify run locks prevent duplicate execution and pause does not release an in-flight worker prematurely.

### Task 2: Add Multi-Select Controls and Results

**Files:**
- Modify: `src/client/components/JobList.tsx`
- Add: `src/client/components/JobList.test.tsx`
- Modify: `src/client/api.ts` if a matching API helper pattern exists
- Modify: `src/client/styles.css`

- [x] Add selection-aware actions for eligible processing/paused jobs; explain eligible counts for mixed selections.
- [x] Disable repeat submissions while busy, retain useful selection on partial outcomes, and display per-task results.
- [x] Add regression tests for visibility, status filtering, mixed selection, and partial outcomes.
- [x] Run focused tests, then the project verification commands required by the change.

### Acceptance

- Batch pause affects only selected processing tasks; batch resume affects only selected paused tasks.
- Each requested task yields success, skipped, or failure with a reason, without aborting other tasks.
- Resume uses the task's original board/config binding and existing analysis budget/locking behavior.
- Unauthorized callers are denied by the server; no database migration is needed.
- No commit, push, merge, or issue closure is performed in this task.
