# 客服聊天截图 Excel AI 解析中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个单用户内部工作台，导入包含聊天截图的 Excel，调用可配置的 OpenAI 兼容视觉模型按板块解析，并导出保留原图和解析字段的新 Excel。

**Architecture:** 采用 React + Vite 前端和 Node.js + Express 服务端的一体化项目。SQLite 保存任务、记录、板块、模型配置和解析运行快照；上传文件与导出中间文件保存在 `data/`；浏览器只访问本地服务端，服务端负责解密 API Key、读取图片、调用模型和写回 Excel。

**Tech Stack:** React, Vite, TypeScript, Node.js, Express, SQLite, Vitest, React Testing Library, OpenAI-compatible HTTP client, ExcelJS/OOXML ZIP utilities, Zod, CSS Modules or scoped CSS.

**Spec:** `docs/superpowers/specs/2026-09-08-customer-chat-excel-analysis-design.md`

## Global Constraints

- 第一版为单用户内部部署，不实现登录、权限和多人协作。
- API Key 只服务端使用，使用 AES-256-GCM 加密后保存，接口只返回脱敏值。
- 真实模型配置来自服务端保存的 Base URL、API Key 和 Model，不在前端写死。
- 原始图片、辅助字段、原始模型响应和人工结果分开保存。
- AI 结果要求结构化 JSON；无法校验时保留原始响应并标记“需复核”。
- 单条解析失败不能阻塞批量任务中的其他记录。
- 导出必须保留原始工作表、辅助字段和图片，并追加解析字段、状态和复核信息。
- 每个实现任务遵循 TDD：先写一个会失败的测试，运行确认失败，再写最小实现。
- 完成前必须运行完整测试、类型检查、构建和可用的浏览器验证。

---

### Task 1: 初始化项目骨架与运行命令

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `src/client/main.tsx`
- Create: `src/client/index.html`
- Create: `src/client/styles.css`
- Create: `src/server/index.ts`
- Create: `src/shared/types.ts`
- Create: `.env.example`
- Create: `.gitignore`
- Test: `src/shared/types.test.ts`

**Interfaces:**
- Produces `npm run dev`, `npm run test`, `npm run typecheck`, `npm run build`.
- Produces shared TypeScript types used by API handlers and React components.

- [ ] **Step 1: Write the failing test**

Create `src/shared/types.test.ts` with a compile-time shape test for a record summary:

```ts
import { describe, expect, it } from "vitest";
import type { RecordSummary } from "./types";

describe("shared record types", () => {
  it("accepts a record summary returned by the API", () => {
    const summary: RecordSummary = {
      id: "record-1",
      rowNumber: 2,
      sheetName: "Sheet1",
      sourceFields: { customer: "张三" },
      imageUrl: "/api/records/record-1/image",
      status: "pending",
      reviewStatus: "pending",
    };
    expect(summary.status).toBe("pending");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/shared/types.test.ts`

Expected: FAIL because the project files and `RecordSummary` type do not exist.

- [ ] **Step 3: Write minimal implementation**

Define shared unions and interfaces:

```ts
export type RecordStatus = "pending" | "processing" | "completed" | "failed" | "needs_review";
export type ReviewStatus = "pending" | "confirmed" | "needs_review";

export interface RecordSummary {
  id: string;
  rowNumber: number;
  sheetName: string;
  sourceFields: Record<string, string>;
  imageUrl: string;
  status: RecordStatus;
  reviewStatus: ReviewStatus;
}
```

Add Vite React entry, Express health route, scripts, environment example and ignore rules.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/shared/types.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the project baseline checks**

Run: `npm run typecheck`

Expected: PASS with no TypeScript errors.

### Task 2: SQLite schema and repository layer

**Files:**
- Create: `src/server/db/client.ts`
- Create: `src/server/db/schema.ts`
- Create: `src/server/db/repositories/model-config-repository.ts`
- Create: `src/server/db/repositories/section-repository.ts`
- Create: `src/server/db/repositories/job-repository.ts`
- Create: `src/server/db/repositories/record-repository.ts`
- Create: `src/server/db/repositories/analysis-run-repository.ts`
- Test: `src/server/db/repositories/repositories.test.ts`

**Interfaces:**
- `createModelConfig(input): ModelConfig`
- `listModelConfigs(): ModelConfig[]`
- `createSection(input): AnalysisSection`
- `createJob(input): Job`
- `createRecord(input): RecordSummary`
- `createAnalysisRun(input): AnalysisRun`

- [ ] **Step 1: Write failing repository tests**

Test that a model config can be inserted and returned with the API key excluded, a job can own records, and an analysis run preserves a configuration snapshot.

- [ ] **Step 2: Run the targeted tests**

Run: `npm test -- src/server/db/repositories/repositories.test.ts`

Expected: FAIL because the database client and repositories are absent.

- [ ] **Step 3: Implement the schema and repositories**

Create the tables from the design spec with foreign keys enabled. Store JSON values as text and parse them at repository boundaries. Seed the five initial analysis sections only when the table is empty.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- src/server/db/repositories/repositories.test.ts`

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

### Task 3: API key encryption and model configuration service

**Files:**
- Create: `src/server/security/secrets.ts`
- Create: `src/server/services/model-config-service.ts`
- Create: `src/server/routes/model-config-routes.ts`
- Test: `src/server/security/secrets.test.ts`
- Test: `src/server/services/model-config-service.test.ts`

**Interfaces:**
- `encryptSecret(value: string, key: Buffer): string`
- `decryptSecret(ciphertext: string, key: Buffer): string`
- `maskSecret(value: string): string`
- `testModelConnection(configId: string): Promise<ModelConnectionTest>`

- [ ] **Step 1: Write failing encryption and service tests**

Assert round-trip encryption, different ciphertext for repeated encryption, invalid ciphertext rejection, API key masking, and that serialized model config responses never contain the plaintext key.

- [ ] **Step 2: Run tests and confirm expected failure**

Run: `npm test -- src/server/security/secrets.test.ts src/server/services/model-config-service.test.ts`

Expected: FAIL because the security and service modules do not exist.

- [ ] **Step 3: Implement AES-256-GCM and model config operations**

Require a 32-byte key from `ENCRYPTION_KEY`. Never return `api_key_ciphertext` from route serializers. Validate Base URL, model name, temperature range and max token range with Zod. A connection test sends a minimal request and returns only success, latency and sanitized error text.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- src/server/security/secrets.test.ts src/server/services/model-config-service.test.ts`

Expected: PASS.

### Task 4: Excel import, image extraction and job creation

**Files:**
- Create: `src/server/services/excel-import-service.ts`
- Create: `src/server/services/image-storage-service.ts`
- Create: `src/server/routes/job-routes.ts`
- Create: `src/server/routes/file-routes.ts`
- Test: `src/server/services/excel-import-service.test.ts`

**Interfaces:**
- `importWorkbook(filePath: string): Promise<ImportedWorkbook>`
- `extractRecords(workbook: ImportedWorkbook): Promise<ImportedRecordInput[]>`
- `getRecordImagePath(recordId: string): string`

- [ ] **Step 1: Add fixture and failing tests**

Create a small `.xlsx` fixture with one sheet, two rows of fields and two embedded images. Test that both rows, field values, sheet name, row number and image files are extracted.

- [ ] **Step 2: Run targeted test**

Run: `npm test -- src/server/services/excel-import-service.test.ts`

Expected: FAIL because import service is absent.

- [ ] **Step 3: Implement import**

Use a structured workbook parser first. Read image anchors and map each image to its anchor start row. Copy image binaries into `data/jobs/<jobId>/images/`, create records with source fields and anchor metadata, and reject workbooks without embedded images.

- [ ] **Step 4: Run targeted test**

Run: `npm test -- src/server/services/excel-import-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Add upload route**

Use multipart upload with file size and extension validation. Return the created job summary and expose images only through a server route that checks the record path stays inside the job data directory.

### Task 5: OpenAI-compatible vision client and result validation

**Files:**
- Create: `src/server/ai/openai-compatible-client.ts`
- Create: `src/server/ai/prompt-builder.ts`
- Create: `src/server/ai/result-validator.ts`
- Create: `src/server/services/analysis-service.ts`
- Test: `src/server/ai/prompt-builder.test.ts`
- Test: `src/server/ai/result-validator.test.ts`
- Test: `src/server/services/analysis-service.test.ts`

**Interfaces:**
- `buildVisionMessages(input: PromptInput): VisionMessage[]`
- `callVisionModel(config: DecryptedModelConfig, messages: VisionMessage[]): Promise<ModelResponse>`
- `validateAnalysisResult(raw: string, schema: OutputField[]): ValidatedAnalysisResult`
- `analyzeRecord(recordId: string, sectionId: string): Promise<AnalysisRun>`

- [ ] **Step 1: Write failing tests**

Test that the message builder includes the section prompt, source fields and a data URL image; the validator accepts valid JSON, extracts a fenced JSON object, and rejects missing required output fields; the analysis service stores a configuration and prompt snapshot.

- [ ] **Step 2: Run targeted tests**

Run: `npm test -- src/server/ai src/server/services/analysis-service.test.ts`

Expected: FAIL because the AI modules are absent.

- [ ] **Step 3: Implement the prompt builder and validator**

Build a system message requiring JSON only and a user content array containing text plus `image_url`. Validate scalar field types, preserve unknown fields under `extra`, and return a `needs_review` result when parsing fails.

- [ ] **Step 4: Implement the compatible client**

Post to `${baseUrl}/chat/completions` with configured model, temperature, max tokens and optional JSON response format. Support both string and array message content. Apply timeout and bounded retries for 408, 429 and 5xx responses.

- [ ] **Step 5: Implement analysis service**

Load record, section and default model; create an analysis run snapshot before the request; save model output, raw response, duration, token usage and status. Update the record to `completed` only after validation succeeds; otherwise use `needs_review`.

- [ ] **Step 6: Run targeted tests**

Run: `npm test -- src/server/ai src/server/services/analysis-service.test.ts`

Expected: PASS.

### Task 6: Job analysis routes and batch execution

**Files:**
- Create: `src/server/services/batch-analysis-service.ts`
- Create: `src/server/routes/analysis-routes.ts`
- Test: `src/server/services/batch-analysis-service.test.ts`

**Interfaces:**
- `analyzeJob(jobId: string, sectionId: string): Promise<BatchProgress>`
- `retryRecord(recordId: string, sectionId: string): Promise<AnalysisRun>`

- [ ] **Step 1: Write failing batch tests**

Use a deterministic analysis service fake to verify one failed record does not prevent later records from running, progress counts are updated, and retry only reprocesses the requested record.

- [ ] **Step 2: Run targeted tests**

Run: `npm test -- src/server/services/batch-analysis-service.test.ts`

Expected: FAIL because batch service is absent.

- [ ] **Step 3: Implement bounded-concurrency batch processing**

Process records with a configurable concurrency limit. Catch failures per record, save failure status and continue. Return totals, completed count, failed count and needs-review count.

- [ ] **Step 4: Add analysis routes**

Implement single record, batch job, retry, record listing and job detail endpoints. Return normalized API envelopes and progress data.

- [ ] **Step 5: Run targeted tests**

Run: `npm test -- src/server/services/batch-analysis-service.test.ts`

Expected: PASS.

### Task 7: Excel export preserving images and appending results

**Files:**
- Create: `src/server/services/excel-export-service.ts`
- Create: `src/server/routes/export-routes.ts`
- Test: `src/server/services/excel-export-service.test.ts`

**Interfaces:**
- `exportJob(jobId: string, sectionIds: string[]): Promise<string>`
- `flattenAnalysisColumns(results: AnalysisResult[]): ExportColumn[]`

- [ ] **Step 1: Write failing export test**

Import the fixture from Task 4, save a completed result and human override, export the job, then inspect the output workbook to assert that original image count is unchanged, source fields remain, analysis columns exist, and human values take precedence over model values.

- [ ] **Step 2: Run targeted test**

Run: `npm test -- src/server/services/excel-export-service.test.ts`

Expected: FAIL because export service is absent.

- [ ] **Step 3: Implement export**

Load the original workbook, append prefixed columns to each relevant sheet, write model or human result values, add parse/review/model/time metadata, and preserve embedded image relationships. Use OOXML ZIP copy/write fallback if the workbook library drops images.

- [ ] **Step 4: Add download route**

Generate the file into `data/exports/`, return it as an attachment, and reject path traversal.

- [ ] **Step 5: Run targeted test**

Run: `npm test -- src/server/services/excel-export-service.test.ts`

Expected: PASS.

### Task 8: React workbench and configuration views

**Files:**
- Create: `src/client/App.tsx`
- Create: `src/client/api.ts`
- Create: `src/client/components/AppShell.tsx`
- Create: `src/client/components/JobSidebar.tsx`
- Create: `src/client/components/RecordTable.tsx`
- Create: `src/client/components/RecordDetail.tsx`
- Create: `src/client/components/SectionTree.tsx`
- Create: `src/client/components/ModelConfigDialog.tsx`
- Create: `src/client/components/SectionConfigDialog.tsx`
- Modify: `src/client/styles.css`
- Test: `src/client/App.test.tsx`
- Test: `src/client/components/ModelConfigDialog.test.tsx`

**Interfaces:**
- `api.importWorkbook(file: File): Promise<Job>`
- `api.analyzeRecord(recordId, sectionId): Promise<AnalysisRun>`
- `api.analyzeJob(jobId, sectionId): Promise<BatchProgress>`
- `api.updateRecord(recordId, input): Promise<RecordDetail>`
- `api.exportJob(jobId, sectionIds): Promise<Blob>`

- [ ] **Step 1: Write failing UI tests**

Test that the empty workbench shows an import action, importing renders the job and records, selecting a record renders the image and fields, and the model dialog masks API keys and exposes a test connection action.

- [ ] **Step 2: Run targeted tests**

Run: `npm test -- src/client/App.test.tsx src/client/components/ModelConfigDialog.test.tsx`

Expected: FAIL because the React components are absent.

- [ ] **Step 3: Implement API client and shell**

Use typed fetch wrappers with normalized error handling. Build the desktop-first three-column workbench with compact controls, clear states and no card nesting. Use an icon library already present after checking `package.json`; if none exists, use accessible text controls until a dependency is intentionally added.

- [ ] **Step 4: Implement record detail and analysis controls**

Render original image, source fields, result fields, confidence, status, review note and save actions. Add single analyze, batch analyze, retry, filter and export actions with loading, disabled, error and empty states.

- [ ] **Step 5: Implement model and section configuration**

Add forms for model fields, masked API key handling, connection testing, default selection, section prompts and output field definitions. Refresh the workbench after saves.

- [ ] **Step 6: Run targeted UI tests**

Run: `npm test -- src/client/App.test.tsx src/client/components/ModelConfigDialog.test.tsx`

Expected: PASS.

### Task 9: Wire server, seed data and production build

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/client/main.tsx`
- Modify: `vite.config.ts`
- Create: `src/server/app.ts`
- Create: `src/server/config.ts`
- Create: `README.md`

- [ ] **Step 1: Add integration smoke test**

Test the Express app health route and route registration using an in-memory database and temporary data directory.

- [ ] **Step 2: Run smoke test to confirm failure**

Run: `npm test -- src/server/app.test.ts`

Expected: FAIL until the app composition and routes are wired.

- [ ] **Step 3: Compose the application**

Load environment configuration, initialize database and directories, register JSON/multipart/static middleware, register all routes, seed default sections, and serve the Vite build in production.

- [ ] **Step 4: Add documented environment configuration**

Document `PORT`, `DATA_DIR`, `DATABASE_PATH`, `ENCRYPTION_KEY`, `MAX_UPLOAD_MB`, `ANALYSIS_CONCURRENCY` and optional default model environment values in `.env.example` and `README.md`.

- [ ] **Step 5: Run full checks**

Run:

```text
npm test
npm run typecheck
npm run build
```

Expected: all tests pass, typecheck exits 0, and the production build completes.

### Task 10: Browser verification and final hardening

**Files:**
- Modify: any file required by verification findings.
- Test: `src/server/services/*.test.ts`, `src/client/*.test.tsx`

- [ ] **Step 1: Start the development server**

Run: `npm run dev -- --host 0.0.0.0`

Expected: a local URL is printed and the health endpoint returns success.

- [ ] **Step 2: Verify the primary workflow in the browser**

Using the attached or equivalent Excel fixture:

1. Import the workbook.
2. Confirm images and source fields appear.
3. Add a model configuration and verify the key is masked after save.
4. Select a section and start a single analysis.
5. Confirm loading, completed and needs-review states are visible.
6. Edit and confirm a result.
7. Export the workbook.

- [ ] **Step 3: Verify output contents**

Open the exported file with a workbook inspection script and assert source fields, images, analysis columns and review values are present.

- [ ] **Step 4: Verify responsive and error states**

Check desktop and narrow viewport layouts, missing-image records, model timeout, invalid JSON response and export with unfinished records.

- [ ] **Step 5: Run final verification**

Run:

```text
npm test
npm run typecheck
npm run build
```

Expected: all checks pass with no unhandled errors or warnings that affect the workflow.
