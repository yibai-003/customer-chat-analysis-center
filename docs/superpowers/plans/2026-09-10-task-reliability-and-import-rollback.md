# Task Reliability and Import Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each parsing task use one explicit analysis section, make batch analysis resumable and retryable, and ensure failed Excel imports leave no partial data or files.

**Architecture:** Keep the current Express, SQLite, React, and ExcelJS architecture. Add task-level section validation and run-state helpers in the server services/repositories, expose pause/cancel/retry-failed endpoints, and update the existing task UI to operate against the bound section. Make workbook import transactional from the application’s perspective by extracting and validating assets before creating the database job, with cleanup on every failure path.

**Tech Stack:** TypeScript, Express 5, SQLite via better-sqlite3, ExcelJS, React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-customer-chat-excel-analysis-design.md`

## Global Constraints

- Single-user local deployment remains supported.
- OpenAI-compatible model calls remain unchanged.
- Existing knowledge-base and export behavior must remain compatible.
- Use the current component structure; do not collapse modules into one file.
- Keep existing database data readable through startup migrations.
- All new behavior must have focused Vitest coverage.

---

### Task 1: Bind Jobs to Analysis Sections

**Files:**
- Modify: `src/server/db/repositories.ts`
- Modify: `src/server/services/excel-import-service.ts`
- Modify: `src/server/app.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/components/JobList.tsx`
- Test: `src/server/db/repositories.test.ts`
- Test: `src/server/services/excel-import-service.test.ts`

**Interfaces:**
- `importWorkbook(filePath, originalFilename, section?)` must reject an invalid or disabled section before creating a job.
- `POST /api/jobs/import` continues accepting `sectionId`, but the response job must contain the normalized bound section.
- `POST /api/jobs/:id/analyze` and record analyze endpoints must reject a section different from `job.sectionId`.
- The client must use `job.sectionId` as the active analysis section for a selected job.

- [ ] **Step 1: Write failing repository and service tests**

Add tests proving that a job bound to section `refund` cannot be analyzed with section `reception`, and that an import with a missing section falls back only when the product’s current behavior explicitly permits an unbound task.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```powershell
npm test -- src/server/db/repositories.test.ts src/server/services/excel-import-service.test.ts
```

Expected: new assertions fail because section mismatch validation is not implemented.

- [ ] **Step 3: Implement section binding and validation**

Add repository helpers:

```ts
export function getJobSection(jobId: string): { id: string; name: string } | undefined;
export function assertJobSection(jobId: string, sectionId: string): void;
```

Use them from the analysis routes/services. In `App.tsx`, set `activeSection` to `job.sectionId` after selecting or importing a job, and disable unrelated section buttons while a bound job is selected or clearly mark them as configuration-only.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```powershell
npm test -- src/server/db/repositories.test.ts src/server/services/excel-import-service.test.ts
npm run typecheck
```

Expected: focused tests and typecheck pass.

### Task 2: Batch Job State, Cancellation, and Failed-Record Retry

**Files:**
- Modify: `src/server/db/client.ts`
- Modify: `src/server/db/repositories.ts`
- Modify: `src/server/services/batch-analysis-service.ts`
- Modify: `src/server/app.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/components/JobList.tsx`
- Test: `src/server/services/batch-analysis-service.test.ts`
- Test: `src/server/db/repositories.test.ts`

**Interfaces:**
- Job statuses become `ready | processing | paused | completed | failed | cancelled`.
- Add `POST /api/jobs/:id/pause`, `POST /api/jobs/:id/cancel`, and `POST /api/jobs/:id/retry-failed`.
- Batch execution must not start twice for the same job.
- Cancellation must stop starting new records; an in-flight model request may finish and its result is retained.
- Retry-failed resets only failed records to `pending` and starts a new run.

- [ ] **Step 1: Write failing state and concurrency tests**

Cover:

```ts
expect(startJob("job-1", "refund")).toBe(true);
expect(startJob("job-1", "refund")).toBe(false);
expect(await cancelJob("job-1")).toMatchObject({ status: "cancelled" });
```

Also verify a cancelled batch does not invoke the runner for records after cancellation and retry-failed selects only failed records.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```powershell
npm test -- src/server/services/batch-analysis-service.test.ts src/server/db/repositories.test.ts
```

Expected: new state-control assertions fail.

- [ ] **Step 3: Add persistent run-state fields and repository helpers**

Add a startup migration for:

```sql
ALTER TABLE jobs ADD COLUMN run_token TEXT;
ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
```

Implement atomic repository operations for acquiring a run token, changing status, requesting cancellation, and selecting failed records.

- [ ] **Step 4: Make the batch worker honor state changes**

Before each record, reload the job and stop if `cancel_requested = 1` or status is `paused`/`cancelled`. Use `try/finally` to release the run token and finalize status. Add a single-run guard in the route before launching `analyzeJob`.

- [ ] **Step 5: Add routes and client controls**

Add task-level pause, cancel, and retry-failed actions to the existing task UI with the same confirm-dialog style already used for deletion. Poll the job while processing, refresh after every control action, and display separate completed, review, failed, and pending counts.

- [ ] **Step 6: Run focused tests, full tests, and typecheck**

Run:

```powershell
npm test -- src/server/services/batch-analysis-service.test.ts src/server/db/repositories.test.ts
npm test
npm run typecheck
```

Expected: all tests and typecheck pass.

### Task 3: Atomic Excel Import and Cleanup

**Files:**
- Modify: `src/server/services/excel-import-service.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/services/job-management-service.ts`
- Test: `src/server/services/excel-import-service.test.ts`
- Test: `src/server/services/job-management-service.test.ts`

**Interfaces:**
- Import must validate `.xlsx`, workbook readability, header row, image count, image buffers, and target section before persisting a job.
- Any failure removes the multer temporary file, extracted job directory, and database job if one was created.
- Successful import removes the multer temporary upload after extraction.
- Empty or corrupt embedded images must fail the import rather than create zero-byte image files.

- [ ] **Step 1: Write failing cleanup tests**

Add tests for:

```ts
await expect(importWorkbook(invalidPath, "bad.xlsx")).rejects.toThrow();
expect(fs.existsSync(partialJobDirectory)).toBe(false);
expect(listJobs()).not.toContainEqual(expect.objectContaining({ originalFilename: "bad.xlsx" }));
```

Also test that a valid import removes its temporary source file after completion.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```powershell
npm test -- src/server/services/excel-import-service.test.ts
```

Expected: cleanup assertions fail against the current partial-write behavior.

- [ ] **Step 3: Refactor import into staged extraction and commit**

Extract workbook images and row metadata into a job staging directory first. Validate every media buffer is non-empty, then create the job and records in one repository transaction. On any error, remove all staged paths and delete the created job if needed.

- [ ] **Step 4: Harden upload route cleanup**

In `POST /api/jobs/import`, always remove `req.file.path` after successful or failed processing unless the service explicitly owns a moved path. Return a user-facing error for unsupported workbook structures.

- [ ] **Step 5: Run full verification**

Run:

```powershell
npm test
npm run typecheck
npm run build
```

Expected: all tests pass, typecheck succeeds, and the production build completes.

## Self-Review Checklist

- Section mismatch is rejected server-side, not only hidden in the UI.
- A second batch run cannot start for the same job.
- Cancellation prevents new records from starting.
- Retry-failed does not re-run completed or manually confirmed records.
- Failed imports do not leave jobs, images, or temporary uploads.
- Existing knowledge-base routes and export routes remain unchanged.
