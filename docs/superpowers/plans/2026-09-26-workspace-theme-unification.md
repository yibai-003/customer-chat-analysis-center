# Workspace Theme Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify authenticated application views with the approved pale blue-gray B visual direction while preserving existing workflows and compact information architecture.

**Architecture:** Add one authenticated-workspace stylesheet loaded after the existing Atelier styles. Scope theme tokens and component overrides to `.app` and `.knowledge-workspace`, leaving the separate sign-in tree and business logic untouched. Extend the existing style-contract test to verify theme tokens, shared controls, and sign-in isolation.

**Tech Stack:** React, TypeScript, CSS, Vitest, Vite, T3 collaborative preview.

**Spec:** GitHub Issue #7, `[UX] 统一内部工作台为 B 方向淡蓝灰视觉风格`; visual reference: Issue #6.

## Global Constraints

- Do not change authentication, permissions, task behavior, model routing/usage, knowledge matching, review, import/export, APIs, or persistence.
- Keep the authenticated application theme scoped away from `.signin-app`.
- Preserve the current compact operational layout and the readability/responsive improvements from Issue #5.
- Add no runtime dependencies, external fonts, or unapproved image assets.
- Preserve the existing dirty worktree; do not commit or push.
- Issue #5 has implementation and synthetic viewport checks, but its real-task-data manual acceptance remains pending.

## Files

- Create `src/client/workspace-theme.css` for B-direction tokens and authenticated-view overrides.
- Modify `src/client/main.tsx` to load the authenticated theme after current styles.
- Modify `src/client/workspace-style-contracts.test.ts` with regression checks for token values, representative common controls, and sign-in isolation.
- Modify `docs/superpowers/plans/2026-09-26-workspace-theme-unification.md` as implementation progresses.

---

### Task 1: Establish the theme contract

- [x] Add tests for the authenticated B palette, shared button/input surfaces, and unchanged sign-in styles.
- [x] Run the focused test and confirm it fails because the workspace theme is not present.

### Task 2: Apply the authenticated workspace theme

- [x] Add scoped tokens for page, surface, text, muted text, borders, accent, semantic states, and restrained shadows.
- [x] Restyle the app header, navigation/sidebar, task list, progress, records, detail panel, buttons, form controls, notices, empty states, and modal surfaces.
- [x] Restyle knowledge workspace navigation, tables, search/import panels, and feedback states.
- [x] Restyle model configuration, usage tables, admin dialogs, and shared tabular/form controls using the same tokens.
- [x] Preserve compact density, existing breakpoints, pixel-art as a minor accent, focus visibility, and status semantics.
- [x] Import the theme after existing app styles, without affecting the sign-in tree.
- [x] Run focused tests and confirm the new contract passes.

### Task 3: Verify cross-view presentation

- [x] Inspect synthetic workbench layouts at 1280px, 1024px, and 390px without accessing real local business data.
- [x] Inspect representative knowledge, model, and management surfaces at desktop and narrow widths.
- [x] Run client tests, typecheck, lint, and a production build to a fresh temporary output directory.
- [x] Record that Issue #5 real-task-data manual acceptance remains pending; keep Issue #7 open until that dependency and all visual acceptance evidence are complete.
