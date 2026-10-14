# Paid Model Pool Filtering and Default Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Keep existing free model configurations and history while exposing and routing only fresh, capability-verified paid pool members, with the purpose default tried first.

**Architecture:** Preserve all model rows and provider credentials. Add one shared eligibility/display predicate for paid, enabled, pooled, general, provider-enabled, capability-verified members; use it for the model-pool API and routing. Keep default models at the bottom of the admin table, but select the purpose default before fallback candidates for each request.

**Tech Stack:** TypeScript, Express, React, SQLite, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-12-qianwen-paid-model-pool-design.md`, amended by the confirmed user behavior in this task.

## Global Constraints

- Do not delete model configurations, providers, usage events, or history when a free member is excluded.
- Do not read or expose API keys, databases, logs, or real business files.
- Do not modify formal LAN data; only the explicitly authorized 8789 test database may be synchronized after code verification.
- Keep existing paid token budgets and retry/cancellation semantics.
- Preserve the existing admin-table placement of the default model at the bottom.

---

### Task 1: Define paid, capability-verified pool eligibility

**Files:**
- Modify: `src/server/services/model-pool-policy.ts`
- Test: `src/server/services/model-pool-policy.test.ts`

- [x] Add failing tests for rejecting free, disabled, non-pooled, stale/failed capability, OCR, and disabled-provider members; accept only enabled paid general members with fresh capability verification.
- [x] Run `npm test -- src/server/services/model-pool-policy.test.ts` and observe the expected failures.
- [x] Implement the shared eligibility predicate and make candidate ranking use it without free-quota branches.
- [x] Re-run the focused policy tests.

### Task 2: Route the default first and keep fallback behavior

**Files:**
- Modify: `src/server/services/model-pool-service.ts`
- Modify: `src/server/services/model-provider-service.ts`
- Test: `src/server/services/model-pool-service.test.ts`
- Test: `src/server/services/model-provider-service.test.ts`

- [x] Add failing tests proving every new request selects the purpose default first, then switches to another verified paid member after a failure; free members are never called.
- [x] Run focused service tests and confirm the old rotation/free-first expectations fail.
- [x] Select the verified purpose default before the fallback round-robin; retain budget reservation and failure handling.
- [x] Update provider connection-test selection to the same paid/default-first policy.
- [x] Re-run focused service tests and adjust obsolete free-quota assertions to the preserved-history/no-routing behavior.

### Task 3: Expose only usable paid members in the model-pool console

**Files:**
- Modify: `src/server/services/model-pool-admin-service.ts`
- Modify: `src/server/routes/model-pool-router.ts`
- Modify: `src/client/components/model-config/PoolView.tsx`
- Test: `src/server/services/model-pool-admin-service.test.ts`
- Test: `src/server/routes/model-pool-router.test.ts`
- Test: `src/client/components/ModelConfigDialog.test.tsx`

- [x] Add failing tests proving the pool API hides free/unverified/disabled members while preserving their database rows, and that the default remains visually last.
- [x] Run the focused admin, route, and UI tests.
- [x] Add a visible-member query/filter using the shared eligibility predicate; keep internal verification and historical usage access independent of the filtered list.
- [x] Update UI summary and empty-state text to describe verified paid members, without displaying free quota language.
- [x] Re-run focused tests.

### Task 4: Synchronize the authorized 8789 test database

**Files:** None.

- [x] Create and verify a full backup of the 8789 test database while no jobs/imports are active.
- [x] Preserve all free rows/history but set free members out of the active pool; keep only verified paid members visible/routable.
- [x] Verify both defaults, readiness, health, database integrity, and foreign keys after restarting the test container.

### Task 5: Full verification and review

- [x] Run focused tests, then the full Vitest suite with one worker (to avoid Windows parallel-worker resource failures), `npm run typecheck`, `npm run lint`, `npm run build`, `npm run db:check`, `npm run smoke`, and `npm run check:installation` as applicable.
- [x] Run `git diff --check` and inspect the diff for accidental changes to the pre-existing reception-quality files.
- [x] Report any environment blockers and leave unrelated user changes uncommitted.
