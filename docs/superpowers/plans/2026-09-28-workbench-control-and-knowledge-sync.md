# Workbench Control And Knowledge Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify every application dropdown, the top user role label, task usage details, and the knowledge workspace with the current pale-blue workbench visual system.

**Architecture:** Add one controlled, accessible `SelectMenu` component for all single-value dropdowns and one focused `UsagePopover` component for task usage disclosure. Existing screens keep ownership of their state and business rules; the shared components only render controls and report selected values. Knowledge pages retain their current React structure while `workspace-theme.css` becomes the final visual override for their shell, tables, empty states, forms, and responsive behavior.

**Tech Stack:** React 19, TypeScript, Vitest, jsdom, CSS, Vite.

**Spec:** GitHub Issue #7 and the approved September 28, 2026 conversation scope.

## Global Constraints

- Preserve existing API calls, permissions, loading states, error states, and business behavior.
- Do not modify the server, database, shared API contracts, or real business data.
- Preserve keyboard access for every migrated dropdown: Enter/Space, arrows, Home/End, Escape, Tab, and outside-click close.
- Respect `prefers-reduced-motion`.
- Keep the existing pale-blue palette and compact workbench density.
- Do not commit or push without a separate user request.
- Do not modify the pre-existing `knowledge/catalog.json` worktree change.

---

### Task 1: Shared Select Menu

**Files:**
- Create: `src/client/components/SelectMenu.tsx`
- Create: `src/client/components/SelectMenu.test.tsx`
- Modify: `src/client/workspace-theme.css`
- Modify: `src/client/workspace-style-contracts.test.ts`

**Interfaces:**
- Consumes: controlled `value`, an array of `{ value: string; label: string; disabled?: boolean }`, and `onChange(value: string)`.
- Produces: `SelectMenu`, supporting `ariaLabel`, `disabled`, `align`, `className`, and compact/full-width presentation.

- [x] **Step 1: Write failing behavior tests**

Test that the trigger exposes `aria-haspopup="listbox"`, opens the listbox, marks the selected option, changes the controlled value, supports arrow navigation and Escape, closes on outside click, and renders disabled state.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm test -- src/client/components/SelectMenu.test.tsx`

Expected: FAIL because `SelectMenu` does not exist.

- [x] **Step 3: Implement the minimal accessible component**

Use a button trigger and listbox popup. Keep state local to open/close and active option index; leave the selected value controlled by the caller.

- [x] **Step 4: Add pale-blue styling and motion contracts**

Style the trigger, caret, popup, options, selected indicator, disabled state, compact/table variants, and reduced-motion behavior.

- [x] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- src/client/components/SelectMenu.test.tsx src/client/workspace-style-contracts.test.ts`

Expected: PASS.

### Task 2: Migrate All Native Selects

**Files:**
- Modify: `src/client/App.tsx`
- Modify: `src/client/components/JobList.tsx`
- Modify: `src/client/components/RecordPager.tsx`
- Modify: `src/client/components/FieldConfigEditor.tsx`
- Modify: `src/client/components/ImportSectionDialog.tsx`
- Modify: `src/client/components/KnowledgeFieldSettings.tsx`
- Modify: `src/client/components/admin/AuditLogDialog.tsx`
- Modify: `src/client/components/admin/PlatformManagementDialog.tsx`
- Modify: `src/client/components/admin/SectionVersionManagementDialog.tsx`
- Modify: `src/client/components/admin/UserManagementDialog.tsx`
- Modify: `src/client/components/knowledge/KnowledgeImportDialog.tsx`
- Modify: `src/client/components/knowledge/KnowledgeItemList.tsx`
- Modify: `src/client/components/knowledge/KnowledgeWorkspace.tsx`
- Modify: `src/client/components/model-config/PoolView.tsx`
- Modify: `src/client/components/model-config/UsageView.tsx`
- Modify nearby tests that currently dispatch native `change` events.

**Interfaces:**
- Consumes: `SelectMenu` from Task 1.
- Produces: zero native `<select>` elements in `src/client/**/*.tsx`.

- [x] **Step 1: Update existing tests to select options through the shared control**

Replace direct `HTMLSelectElement.value` mutation with trigger and option interaction. Add a repository contract asserting that production TSX files contain no native `<select>`.

- [x] **Step 2: Run affected tests and verify RED**

Run the focused component suites for each migrated area.

Expected: FAIL because screens still render native selects.

- [x] **Step 3: Replace native selects without changing state ownership**

Convert each option set to `SelectMenu` data. Preserve existing casts, numeric conversion, disabled behavior, and labels.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- src/client`

Expected: PASS.

### Task 3: Role Label And Usage Popover

**Files:**
- Create: `src/client/components/UsagePopover.tsx`
- Create: `src/client/components/UsagePopover.test.tsx`
- Modify: `src/client/components/JobList.tsx`
- Modify: `src/client/components/JobList.test.tsx`
- Modify: `src/client/workspace-theme.css`
- Modify: `src/client/workspace-style-contracts.test.ts`

**Interfaces:**
- Consumes: `JobUsageSummary` values already delivered with each job.
- Produces: compact usage triggers for job and board totals, with input, output, accounted, calls, and unknown-call details.

- [x] **Step 1: Write failing tests for role color and usage disclosure**

Assert that the role badge resolves to the pale-blue variables and that job/board usage details appear on hover or focus with correct aggregated values.

- [x] **Step 2: Run focused tests and verify RED**

Run: `npm test -- src/client/components/JobList.test.tsx src/client/components/UsagePopover.test.tsx src/client/workspace-style-contracts.test.ts`

Expected: FAIL because the popover and role override are absent.

- [x] **Step 3: Implement the usage disclosure and role override**

Keep job navigation separate from the focusable usage trigger, aggregate all usage fields for board totals, and apply pale-blue default/hover/expanded role badge styles.

- [x] **Step 4: Run focused tests and verify GREEN**

Run the same focused command and expect PASS.

### Task 4: Knowledge Workspace Visual Synchronization

**Files:**
- Modify: `src/client/workspace-theme.css`
- Modify: `src/client/workspace-style-contracts.test.ts`
- Modify: `src/client/components/knowledge/KnowledgeWorkspace.test.tsx`
- Modify knowledge component markup only where a class or semantic hook is required.

**Interfaces:**
- Consumes: shared workbench variables and `SelectMenu`.
- Produces: a compact pale-blue knowledge shell with matching controls, tables, empty states, overlays, and responsive layout.

- [x] **Step 1: Write failing visual contracts**

Assert compact shell dimensions, pale-blue active tabs, removal of old hard shadows and green primary surfaces, restrained empty-state height, synchronized table headers, and absence of the old decorative fern.

- [x] **Step 2: Run focused tests and verify RED**

Run: `npm test -- src/client/components/knowledge/KnowledgeWorkspace.test.tsx src/client/workspace-style-contracts.test.ts`

Expected: FAIL on the old knowledge geometry and visual rules.

- [x] **Step 3: Apply final knowledge workspace overrides**

Synchronize topbar, tabs, status counters, main spacing, sticky actions, tables, forms, empty states, import dialog, search view, and mobile breakpoints. Remove remaining pixel-style borders, offset shadows, and green control surfaces.

- [x] **Step 4: Run focused tests and verify GREEN**

Run the same focused command and expect PASS.

### Task 5: Verification And Visual Acceptance

**Files:**
- No additional production files unless verification finds a regression.

- [x] **Step 1: Run the client test suite**

Run: `npm test -- src/client`

- [x] **Step 2: Run static verification**

Run: `npm run typecheck`

Run: `npm run lint`

Run: `npm run build`

- [x] **Step 3: Inspect the actual application**

Use the collaborative preview at `http://localhost:8788/` to verify the main workspace, every representative dropdown context, task usage popup, and knowledge workspace at desktop and narrow widths.

- [x] **Step 4: Confirm repository state**

Run: `git status --short --branch`

Report all remaining uncommitted files and identify `knowledge/catalog.json` as pre-existing.
