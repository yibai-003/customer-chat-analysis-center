# Platform Dictionary and Task Binding Plan

> **Execution note:** Follow the TDD loop for every task: add a focused failing test, run it to confirm the expected failure, implement the smallest compatible change, then rerun the focused and related suites.

**Goal:** Add a maintained platform dictionary and make new import tasks bind one enabled platform, one section, and the section's current published version immutably, including source-platform validation and one-time historical backfill.

**Architecture:** Keep platform state in a dedicated repository/service boundary. Extend `jobs` and `import_jobs` with immutable platform bindings and versioned snapshots. Validate the selected platform and workbook platform column before creating the job or records. Expose platform maintenance and historical backfill through the existing admin router and config-management capability, and extend the import workflow with required platform selection and current-version display.

**Tech stack:** TypeScript, Express, better-sqlite3, Vitest, React.

## Tasks

### 1. Establish the platform schema and shared contracts

- Add a migration after schema version 19 for the platform dictionary, job/import bindings, indexes, and one-time backfill metadata.
- Update migration registration and immutable migration locks.
- Add `Platform`, platform conflict, and binding fields to shared types.
- Add migration tests for uniqueness, enabled-state fields, foreign keys, and existing-row compatibility.
- Run the migration-focused tests and confirm they fail before implementation.

### 2. Implement platform dictionary operations

- Add repository/service functions to list, create, rename, disable, restore, and resolve enabled platforms.
- Enforce normalized globally unique codes, code immutability after first use, and no deletion.
- Record maintenance actions through the existing audit mechanism.
- Add repository/service tests for duplicate codes, disabled-platform rejection, code immutability, and restore.

### 3. Bind platforms and published section versions to tasks

- Extend `createJob`, `createImportJob`, job mapping, and import-job mapping with platform snapshots and current published section version binding.
- Keep legacy unbound records readable while requiring the new import path to provide exactly one enabled section and platform.
- Prevent changes to a bound job's section, platform, or version.
- Add tests for immutable bindings, missing current version, disabled platform, and historical version non-selection.

### 4. Validate workbook platform values before import

- Add shared platform-column normalization and conflict collection to the streaming workbook service.
- Treat a missing platform column or blank cell as the selected task platform.
- Collect every non-empty row conflict against the selected platform and fail the whole import before job/record creation.
- Thread the platform binding through the import worker and HTTP preview/import endpoints.
- Add service and HTTP tests for missing column, blank cells, all-row conflict reporting, and no partial task creation.

### 5. Add historical one-time platform backfill

- Add an admin/config operation to list eligible historical jobs and backfill a selected platform once.
- Reject backfill when a job is already bound or the platform is disabled; make the backfill immutable after success.
- Write an audit event containing the job, platform, actor, and reason.
- Add tests for successful backfill, repeated backfill rejection, no automatic inference, and audit metadata.

### 6. Complete the import UI and platform maintenance UI

- Load enabled platforms for the import form and require one selection alongside the required section.
- Display the selected section's current published version and prevent historical-version selection.
- Surface all workbook platform conflicts before commit and keep the commit disabled until validation succeeds.
- Add platform dictionary maintenance controls for create, rename, disable, and restore with permission-aware states.
- Add focused component/workflow tests for required selection, disabled options, current-version display, and conflict rendering.

### 7. Verify and record the work

- Run focused migration, repository, service, HTTP, and client tests.
- Run the full test suite with the repository's supported command, documenting the pre-existing environment-path failure if it remains.
- Inspect the diff for unintended changes, update the issue evidence/status file, and commit the completed ticket-2 implementation on the feature branch.
