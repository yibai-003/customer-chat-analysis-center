# Large File Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert Excel import into an observable background job that can later support 800 MB workbooks without holding the upload request open.

**Architecture:** Add a persistent `import_jobs` table and an in-process worker registry. The upload endpoint stores the file and creates an import job, then returns immediately; the worker processes the workbook in the background and updates progress. Existing synchronous import remains available internally for the worker, while the client switches to preview, start, poll, and refresh behavior.

**Tech Stack:** TypeScript, Express 5, SQLite via better-sqlite3, React 19, ExcelJS, Vitest.

**Spec:** `docs/large-file-processing-flow.md`

## Global Constraints

- Single-user local deployment remains supported.
- Existing `.xlsx` image extraction and export behavior remains compatible.
- The first phase must not claim true streaming extraction until implemented.
- Background failures must be persisted and visible after server restart.
- A user cannot start the same import job twice.
- All new APIs return the existing `{ success, data, error }` envelope.
- Keep modules separated by upload, import worker, repository, and UI responsibility.

---

### Task 1: Persist Import Jobs

**Files:**
- Modify: `src/server/db/client.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/server/db/repositories.ts`
- Test: `src/server/db/repositories.test.ts`

**Interfaces:**
- `ImportJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled"`.
- `createImportJob(input)` returns an `ImportJob`.
- `getImportJob(id)` and `updateImportJob(id, patch)` persist progress.
- `claimImportJob(id)` atomically changes `queued` to `processing`.

- [ ] **Step 1: Write failing repository tests**

Cover creation, atomic claiming, progress updates, and persisted failure messages.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
npm test -- src/server/db/repositories.test.ts
```

- [ ] **Step 3: Add schema migration and repository functions**

Add `import_jobs` with filename, source path, job id, status, image and record counters, current sheet/row, error message, timestamps, and a unique `job_id`.

- [ ] **Step 4: Run focused tests and typecheck**

```powershell
npm test -- src/server/db/repositories.test.ts
npm run typecheck
```

### Task 2: Background Import Worker

**Files:**
- Create: `src/server/services/import-worker.ts`
- Modify: `src/server/services/excel-import-service.ts`
- Modify: `src/server/services/job-management-service.ts`
- Test: `src/server/services/import-worker.test.ts`

**Interfaces:**
- `startImportJob(importJobId: string): void`.
- `runImportJob(importJobId: string): Promise<ImportJob>`.
- `recoverImportJobs(): void`.
- Worker execution must claim once, persist `processing`, update counters, and persist `failed` errors.

- [ ] **Step 1: Write failing worker tests**

Cover duplicate start prevention, success completion, and persisted failure.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
npm test -- src/server/services/import-worker.test.ts
```

- [ ] **Step 3: Refactor current import into worker-owned execution**

Move the current workbook extraction and job creation into the worker path. Update progress after each worksheet/image batch and delete temporary upload files in `finally`.

- [ ] **Step 4: Add startup recovery**

On server startup, mark stale `processing` imports as `queued` and restart them. Do not restart `completed`, `failed`, or `cancelled` imports.

- [ ] **Step 5: Run focused tests**

```powershell
npm test -- src/server/services/import-worker.test.ts src/server/services/excel-import-service.test.ts
npm run typecheck
```

### Task 3: Upload and Import APIs

**Files:**
- Modify: `src/server/app.ts`
- Modify: `src/server/services/excel-import-service.ts`
- Test: `src/server/routes/import-routes.test.ts`

**Interfaces:**
- `POST /api/jobs/import` returns `{ importJobId, status: "queued" }` after moving the upload into a durable location.
- `GET /api/import-jobs/:id` returns progress.
- `POST /api/import-jobs/:id/cancel` requests cancellation.
- Existing `POST /api/jobs/import-preview` remains synchronous and does not create a job.

- [ ] **Step 1: Write failing route tests**

Verify upload returns before the worker completes, status polling returns progress, invalid extensions are deleted, and cancellation is persisted.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
npm test -- src/server/routes/import-routes.test.ts
```

- [ ] **Step 3: Implement durable upload handoff**

Move the multer file into `data/imports/{importJobId}/source.xlsx`, create the import job, start the worker, and return immediately.

- [ ] **Step 4: Implement polling and cancellation**

Return the persisted state and prevent cancellation after completion. The worker must stop starting new image/record work after cancellation.

- [ ] **Step 5: Run route tests and typecheck**

```powershell
npm test -- src/server/routes/import-routes.test.ts
npm run typecheck
```

### Task 4: Client Import Progress

**Files:**
- Create: `src/client/components/ImportProgressDialog.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/components/ImportPreviewDialog.tsx`
- Modify: `src/client/styles.css`
- Test: `src/client/components/ImportProgressDialog.test.tsx`

**Interfaces:**
- The preview confirmation starts the background import instead of awaiting a completed job.
- The progress dialog polls `GET /api/import-jobs/:id`.
- Completion refreshes the selected analysis job.
- Failure shows the persisted error and does not create a false successful task.

- [ ] **Step 1: Write failing component tests**

Cover queued, processing, completed, failed, and cancelled states.

- [ ] **Step 2: Run focused test and verify failure**

```powershell
npm test -- src/client/components/ImportProgressDialog.test.tsx
```

- [ ] **Step 3: Implement progress dialog and polling**

Use the existing modal style and stop polling on terminal states.

- [ ] **Step 4: Run client tests and typecheck**

```powershell
npm test -- src/client/components/ImportProgressDialog.test.tsx
npm run typecheck
```

### Task 5: Verification and Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/large-file-processing-flow.md`

- [ ] **Step 1: Run full tests**

```powershell
npm test
npm run typecheck
npm run build
```

- [ ] **Step 2: Verify server health and UI**

Start `npm run dev`, check `/api/health`, upload a small image workbook, confirm progress transitions, and confirm the resulting analysis task is available.

- [ ] **Step 3: Document current limitation**

Explicitly state that this phase makes import asynchronous and recoverable, but true low-memory streaming extraction still requires the next phase.
