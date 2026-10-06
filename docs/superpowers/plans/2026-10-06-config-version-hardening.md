# Configuration Version Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each behavior before implementation.

**Goal:** Close the configuration-version boundary risks identified after the first configuration-driven release.

**Architecture:** Keep the published version snapshot as the source of truth. The server rejects invalid snapshots before publication, while the editor makes stable field identity and version API failure states explicit. Generic export columns remain derived from enabled fields and their configured output settings.

**Tech Stack:** React, TypeScript, Express, Zod, SQLite, Vitest, Vite.

**Spec:** `docs/work-items/config-driven-sections/spec.md`, GitHub Issue #11.

## Global Constraints

- Published versions are immutable; new tasks bind one published version.
- Existing field `key` values are stable identities; changing a key means replacing the field.
- An enabled field may not depend on a disabled field.
- Disabled fields remain in editable snapshots so they can be re-enabled, but they do not execute or export.
- Version API failures must not silently switch the normal version editor to legacy live CRUD.
- Do not modify the `main` checkout or any production/daily-use database.

---

### Task 1: Harden Snapshot and Export Semantics

**Files:**
- Modify: `src/server/services/section-config-version-service.ts`
- Modify: `src/server/services/section-export-settings.ts`
- Test: `src/server/services/section-config-version-service.test.ts`

**Interfaces:**
- `buildCurrentSnapshot(sectionId)` returns enabled and disabled live fields for initial/compatibility snapshots.
- `buildDraftSnapshot(sectionId)` imports only genuinely new enabled legacy fields into an existing published snapshot, so deleted disabled fields are not resurrected.
- `validateVersionSnapshot(version)` rejects an enabled field that depends on a disabled field.
- Generic `sectionExportSettings` includes only fields where `isEnabled && exportEnabled`.

- [x] Write tests for preserving disabled fields in a new draft, excluding them from generic export columns, rejecting enabled-to-disabled dependencies, and not resurrecting a deleted field after a later draft.
- [x] Run `npm.cmd test -- src/server/services/section-config-version-service.test.ts` and confirm the new tests fail for the current implementation.
- [x] Implement the smallest snapshot and export changes.
- [x] Rerun the focused test file and confirm it passes.

### Task 2: Make Field Identity Explicit in the Editor

**Files:**
- Modify: `src/client/components/FieldConfigEditor.tsx`
- Test: `src/client/components/FieldConfigEditor.test.tsx`

**Interfaces:**
- Existing fields render a read-only `字段 Key` control.
- Unsaved fields whose IDs start with `new-` keep an editable Key control.
- Export-column editing remains available through `outputColumn` and `exportEnabled` for generic fields.

- [x] Add a failing UI test that existing field keys are read-only while a newly added field key is editable.
- [x] Run the focused client test and confirm the failure.
- [x] Add the identity-aware read-only behavior without changing server validation.
- [x] Rerun the focused client test and confirm it passes.

### Task 3: Prevent Silent Legacy Fallback

**Files:**
- Modify: `src/client/components/SectionConfigDialog.tsx`
- Test: `src/client/components/FieldConfigEditor.test.tsx`

**Interfaces:**
- API errors carry the HTTP status needed by the editor.
- The version editor falls back to legacy field CRUD only for an explicit `404` or `405` from the version-list endpoint.
- `500`, `401`, malformed version data, and other failures remain in the version view and show an error; they never issue `/fields` or legacy PATCH/POST requests.

- [x] Add a failing test for a version-list `500` response and assert that no legacy `/fields` request is made.
- [x] Add a compatibility test for a `404` response if the existing legacy path is retained.
- [x] Implement status-aware error handling and remove broad fallback behavior.
- [x] Rerun the focused client tests.

### Task 4: Full Verification and Delivery Evidence

**Files:**
- No production files unless a preceding regression test requires a correction.

- [x] Run `npm.cmd test`.
- [x] Run `npm.cmd run typecheck`.
- [x] Run `npm.cmd run lint`.
- [x] Run `npm.cmd run build`.
- [x] Run `npm.cmd run db:check` against the branch-specific data directory.
- [x] Run `npm.cmd run smoke` and the reception XLSX tests/gate.
- [x] Inspect `git diff --check`, `git status`, and the commit list before handoff.
