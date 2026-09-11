# Batch Analysis Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 分页加载数千条记录，并用按批调度、动态推荐参数的后台解析替代一次性全量执行。

**Architecture:** 数据库仓储层提供分页查询和批次候选查询；批量解析服务只持有当前批次并在批次间让出事件循环。独立容量服务根据 CPU、可用内存、数据盘空间和运行任务数生成保守建议，前端通过独立弹窗确认本次运行参数。

**Tech Stack:** TypeScript、Express、React、better-sqlite3、Vitest

**Spec:** `docs/superpowers/specs/2026-09-10-batch-analysis-performance-design.md`

## Global Constraints

- 默认分页大小为 50，最大为 200。
- 默认批次大小为 20，运行时允许 5-100。
- 默认 AI 并发为 2，运行时允许 1-6。
- 前端任务轮询间隔为 2 秒。
- 不引入 Redis、消息队列或独立 Worker 服务。
- 不改变字段解析链、模型接口和导出逻辑。

---

### Task 1: 记录分页仓储与接口

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/server/db/client.ts`
- Modify: `src/server/db/repositories.ts`
- Modify: `src/server/app.ts`
- Test: `src/server/db/repositories.test.ts`

**Interfaces:**
- Produces: `RecordPage`, `RecordPageQuery`
- Produces: `listRecordsPage(jobId, query): RecordPage`
- Existing `listRecords(jobId)` remains available for export and compatibility.

- [ ] **Step 1: Write the failing repository tests**

Add tests that create 120 records and assert:

```ts
const page = listRecordsPage(job.id, { page: 2, pageSize: 50 });
expect(page.items).toHaveLength(50);
expect(page.items[0].rowNumber).toBe(51);
expect(page.total).toBe(120);
```

Add a status-filter test where `completed` and `needs_review` records are returned independently.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx vitest run src/server/db/repositories.test.ts
```

Expected: failure because `listRecordsPage` does not exist.

- [ ] **Step 3: Add types, indexes, and paginated queries**

Define:

```ts
export interface RecordPageQuery {
  page?: number;
  pageSize?: number;
  status?: string;
}

export interface RecordPage {
  items: RecordSummary[];
  total: number;
  page: number;
  pageSize: number;
}
```

Clamp `page >= 1` and `pageSize` to `1-200`. Query `records` with `LIMIT` and `OFFSET`; when status is supplied, match either `status` or `review_status`.

Create indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_records_job_status_row
ON records(job_id, status, row_number);

CREATE INDEX IF NOT EXISTS idx_records_job_review_row
ON records(job_id, review_status, row_number);
```

- [ ] **Step 4: Change the records API**

Make `GET /api/jobs/:id/records` return `RecordPage`, reading `page`, `pageSize`, and `status` from query parameters.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
npx vitest run src/server/db/repositories.test.ts
```

Expected: all repository tests pass.

### Task 2: 本机容量推荐服务

**Files:**
- Create: `src/server/services/analysis-capacity-service.ts`
- Create: `src/server/services/analysis-capacity-service.test.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/server/app.ts`

**Interfaces:**
- Produces: `getAnalysisCapacity(): AnalysisCapacity`
- Produces: `recommendAnalysisSettings(input): { concurrency: number; batchSize: number; warnings: string[] }`
- API: `GET /api/system/analysis-capacity`

- [ ] **Step 1: Write deterministic failing recommendation tests**

Test pure inputs:

```ts
expect(recommendAnalysisSettings({
  logicalProcessors: 20,
  totalMemoryGb: 16,
  freeMemoryGb: 2.4,
  diskFreeGb: 380,
  activeJobs: 0,
})).toMatchObject({ concurrency: 1, batchSize: 10 });
```

Also assert 8 GB free memory recommends concurrency 3 and batch size 30, and an active job reduces the recommendation.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx vitest run src/server/services/analysis-capacity-service.test.ts
```

Expected: failure because the service does not exist.

- [ ] **Step 3: Implement the pure recommendation function**

Use:

```ts
const cpuLimit = clamp(Math.floor(logicalProcessors / 4), 1, 4);
const memoryLimit = freeMemoryGb < 3 ? 1 : freeMemoryGb < 6 ? 2 : freeMemoryGb < 12 ? 3 : 4;
const concurrency = clamp(Math.floor(Math.min(cpuLimit, memoryLimit) / Math.max(1, activeJobs + 1)), 1, 4);
const batchSize = clamp(concurrency * 10, 10, 40);
```

Add warnings for less than 3 GB free memory, less than 10 GB disk space, and active competing jobs.

- [ ] **Step 4: Implement Windows-compatible metric collection**

Use Node APIs for CPU and memory. Resolve the data drive from `config.dataDir`; use `fs.statfsSync` for available bytes. Count processing jobs through a focused repository query.

- [ ] **Step 5: Expose and test the endpoint**

Add `GET /api/system/analysis-capacity`, returning metrics, recommendation, allowed ranges, and warnings.

Run:

```powershell
npx vitest run src/server/services/analysis-capacity-service.test.ts
```

Expected: all capacity tests pass.

### Task 3: 分批解析调度

**Files:**
- Modify: `src/server/config.ts`
- Modify: `.env.example`
- Modify: `src/shared/types.ts`
- Modify: `src/server/db/repositories.ts`
- Modify: `src/server/services/batch-analysis-service.ts`
- Modify: `src/server/services/batch-analysis-service.test.ts`
- Modify: `src/server/app.ts`

**Interfaces:**
- Produces: `listBatchRecordIds(jobId, limit, statuses): string[]`
- Changes: `analyzeJob(jobId, sectionId, options?)`
- Options: `{ concurrency?: number; batchSize?: number; recordIds?: string[] }`

- [ ] **Step 1: Write failing batch-loop tests**

Add a pure `runInBatches` test:

```ts
const loaded: number[] = [];
await runInBatches({
  batchSize: 2,
  loadBatch: async () => {
    loaded.push(1);
    return loaded.length === 1 ? [1, 2] : loaded.length === 2 ? [3] : [];
  },
  runItem: async () => undefined,
  shouldStop: () => false,
});
expect(loaded).toHaveLength(3);
```

Add a pause test proving no second batch is loaded after `shouldStop()` becomes true.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx vitest run src/server/services/batch-analysis-service.test.ts
```

Expected: failure because `runInBatches` does not exist.

- [ ] **Step 3: Implement batch candidate queries**

Select only IDs needed for the next batch, ordered by row number. Normal runs select `pending`, `failed`, and `needs_review`; retry-failed passes an explicit record ID set.

- [ ] **Step 4: Implement bounded batch execution**

For each batch:

1. Run at the requested concurrency.
2. Check pause/cancel before loading and before starting each item.
3. Accumulate field and record counters.
4. Write job progress once after the batch.
5. Await `setImmediate` before loading the next batch.

Validate run options with concurrency `1-6` and batch size `5-100`, falling back to configuration defaults.

- [ ] **Step 5: Update configuration and API**

Add:

```env
ANALYSIS_BATCH_SIZE=20
```

Accept `{ sectionId, concurrency, batchSize }` on `POST /api/jobs/:id/analyze`. Keep single-record routes unchanged.

- [ ] **Step 6: Run batch tests and verify GREEN**

Run:

```powershell
npx vitest run src/server/services/batch-analysis-service.test.ts
```

Expected: all batch tests pass.

### Task 4: 前端分页记录列表

**Files:**
- Create: `src/client/components/RecordPager.tsx`
- Create: `src/client/components/RecordPager.test.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`

**Interfaces:**
- Consumes: `RecordPage`
- Produces: page controls with `page`, `total`, `pageSize`, and `onPageChange`.

- [ ] **Step 1: Write failing pager tests**

Assert previous is disabled on page 1, next changes to page 2, and the label reports `1-50 / 6000`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx vitest run src/client/components/RecordPager.test.tsx
```

Expected: failure because `RecordPager` does not exist.

- [ ] **Step 3: Implement the pager**

Use compact icon buttons for previous and next, a fixed page-size selector, and a stable-width count label.

- [ ] **Step 4: Replace full-record refresh in App**

Track `recordPage`, `page`, and `pageSize`. Fetch:

```ts
`/api/jobs/${jobId}/records?page=${page}&pageSize=${pageSize}&status=${filter}`
```

Reset page to 1 when task or filter changes. Do not filter records again in browser.

- [ ] **Step 5: Verify component tests**

Run:

```powershell
npx vitest run src/client/components/RecordPager.test.tsx
```

Expected: all pager tests pass.

### Task 5: 批量解析运行设置弹窗

**Files:**
- Create: `src/client/components/AnalysisRunDialog.tsx`
- Create: `src/client/components/AnalysisRunDialog.test.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`

**Interfaces:**
- Consumes: `AnalysisCapacity`
- Produces: `{ concurrency: number; batchSize: number }` through `onConfirm`.

- [ ] **Step 1: Write failing dialog tests**

Assert the dialog displays CPU/memory/disk values, initializes inputs from the recommendation, warns above recommendation, and submits chosen values.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx vitest run src/client/components/AnalysisRunDialog.test.tsx
```

Expected: failure because the dialog does not exist.

- [ ] **Step 3: Implement the dialog**

Use existing modal styling. Provide numeric steppers constrained to server ranges, a visible recommendation row, warning text, cancel, and “按此配置开始解析”.

- [ ] **Step 4: Integrate batch startup and polling**

Clicking batch analysis first loads `/api/system/analysis-capacity`. Confirmation posts `concurrency` and `batchSize`. Poll job summary every 2 seconds without setting the whole page busy; refresh the current record page only when progress counters change and once at terminal status.

- [ ] **Step 5: Run dialog tests and verify GREEN**

Run:

```powershell
npx vitest run src/client/components/AnalysisRunDialog.test.tsx
```

Expected: all dialog tests pass.

### Task 6: Full Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document settings and behavior**

Document `ANALYSIS_BATCH_SIZE`, record pagination, dynamic recommendation limits, and the fact that API provider rate limits may require lowering concurrency.

- [ ] **Step 2: Run all automated verification**

Run:

```powershell
npm test
npm run typecheck
npm run build
```

Expected: all tests, type checking, and production build pass.

- [ ] **Step 3: Run browser verification**

Start the development server, open `http://localhost:8787`, and verify:

1. A large task renders only 50 record rows.
2. Pagination changes pages without loading all thumbnails.
3. Batch analysis opens the capacity dialog.
4. Recommended values match the capacity endpoint.
5. Starting analysis leaves navigation and record browsing responsive.
6. Pause and cancel still work.
