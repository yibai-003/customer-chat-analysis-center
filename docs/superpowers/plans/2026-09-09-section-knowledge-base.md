# Section Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-section Excel-backed knowledge bases, local Chinese candidate retrieval, one-model knowledge matching, and deterministic result extraction.

**Architecture:** Store dynamic knowledge rows as JSON with a saved column schema and an FTS5 trigram index. A `knowledge_match` field retrieves local candidates and asks the text model to select one stable item ID; `knowledge_extract` fields copy configured columns from the saved match snapshot without additional model calls.

**Tech Stack:** TypeScript, Express 5, React 19, SQLite 3.53/FTS5, better-sqlite3, ExcelJS, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-09-section-knowledge-base-design.md`

## Global Constraints

- Knowledge bases are isolated by analysis section.
- Excel schemas are dynamic and must not hardcode level-one, level-two, or level-three column names.
- Re-import performs add/update/skip and never deletes missing old rows.
- Knowledge matching may only select an ID from the retrieved candidate set.
- Extraction fields never call a model and all use the same persisted match snapshot.
- Internal fields with `exportEnabled: false` are excluded from record review controls and Excel export.
- Historical match snapshots remain valid after knowledge edits or deletion.
- Keep the current single-user server-side persistence model and pixel-style UI.
- Use the existing two model purposes: `vision` for image fields and `text` for knowledge matching.
- This workspace is not a Git repository, so the commit steps normally required by the planning workflow are replaced with test and review checkpoints.

---

### Task 1: Shared Types And Database Migration

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/types.test.ts`
- Modify: `src/server/db/client.ts`
- Modify: `src/server/db/repositories.test.ts`

**Interfaces:**
- Produces: `KnowledgeColumnRole`, `KnowledgeColumn`, `KnowledgeBase`, `KnowledgeItem`, `KnowledgeImportPreview`, `KnowledgeCandidate`.
- Extends: `AnalysisField.executionType`, `exportEnabled`, `knowledgeBaseId`, `candidateLimit`, `matchFieldKey`, `knowledgeColumn`.

- [x] **Step 1: Write failing shared type and migration tests**

```ts
const field: AnalysisField = {
  ...baseField,
  executionType: "knowledge_extract",
  exportEnabled: true,
  matchFieldKey: "reasonPathMatch",
  knowledgeColumn: "三级原因",
};
expect(field.executionType).toBe("knowledge_extract");
expect(db.prepare("PRAGMA table_info(knowledge_items)").all()).toEqual(
  expect.arrayContaining([expect.objectContaining({ name: "values_json" })]),
);
```

- [x] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- src/shared/types.test.ts src/server/db/repositories.test.ts`

Expected: type or table assertion failures because the knowledge types and tables do not exist.

- [x] **Step 3: Add shared types**

```ts
export type AnalysisExecutionType = "ai" | "knowledge_match" | "knowledge_extract";
export type KnowledgeColumnRole =
  | "result" | "search" | "keyword" | "description"
  | "positive_example" | "negative_example" | "metadata";

export interface KnowledgeColumn {
  name: string;
  roles: KnowledgeColumnRole[];
  requiredParent?: string;
}

export interface KnowledgeBase {
  id: string;
  sectionId: string;
  name: string;
  originalFilename: string;
  columns: KnowledgeColumn[];
  itemCount: number;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeItem {
  id: string;
  knowledgeBaseId: string;
  values: Record<string, string>;
  isEnabled: boolean;
  sourceRowNumber?: number;
  updatedAt: string;
}

export interface KnowledgeImportPreview {
  token: string;
  headers: string[];
  totalRows: number;
  added: number;
  updated: number;
  skipped: number;
  duplicateRows: number;
  errors: Array<{ rowNumber: number; message: string }>;
}

export interface KnowledgeImportResult {
  knowledgeBase: KnowledgeBase;
  added: number;
  updated: number;
  skipped: number;
}

export interface KnowledgeItemQuery {
  search?: string;
  enabled?: boolean;
  page?: number;
  pageSize?: number;
}

export interface KnowledgeItemPage {
  items: KnowledgeItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface KnowledgeCandidate {
  itemId: string;
  values: Record<string, string>;
  score: number;
  matchedText: string;
}

export interface KnowledgeMatchResult {
  status: "completed" | "needs_review";
  result: Record<string, string>;
  snapshotId?: string;
  errorMessage?: string;
}

export type KnowledgeBaseInput = Omit<KnowledgeBase, "id" | "itemCount" | "createdAt" | "updatedAt"> & { id?: string };
export type KnowledgeItemInput = Omit<KnowledgeItem, "id" | "updatedAt"> & { id?: string };
```

Extend `AnalysisField` and `AnalysisFieldInput` with the new execution settings, using defaults that preserve current AI behavior.

- [x] **Step 4: Add tables and field columns**

Create `knowledge_bases`, `knowledge_imports`, `knowledge_items`, `knowledge_match_snapshots`, and `knowledge_item_fts`. Add analysis field columns with migration checks:

```sql
execution_type TEXT NOT NULL DEFAULT 'ai',
export_enabled INTEGER NOT NULL DEFAULT 1,
knowledge_base_id TEXT,
candidate_limit INTEGER NOT NULL DEFAULT 15,
match_field_key TEXT,
knowledge_column TEXT
```

Create FTS with:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_item_fts
USING fts5(item_id UNINDEXED, knowledge_base_id UNINDEXED, search_text, tokenize='trigram');
```

- [x] **Step 5: Run focused and full tests**

Run: `npm test -- src/shared/types.test.ts src/server/db/repositories.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS after all constructors and legacy mappings receive defaults.

---

### Task 2: Knowledge Repositories And Excel Import

**Files:**
- Create: `src/server/services/knowledge/knowledge-repository.ts`
- Create: `src/server/services/knowledge/knowledge-import-service.ts`
- Create: `src/server/services/knowledge/knowledge-import-service.test.ts`
- Create: `src/server/services/knowledge/knowledge-test-fixtures.ts`

**Interfaces:**
- Produces:
  - `previewKnowledgeImport(filePath, originalFilename, sectionId, columns?): Promise<KnowledgeImportPreview>`
  - `importKnowledgeWorkbook(input): Promise<KnowledgeImportResult>`
  - CRUD repository functions for bases and items.
- Consumes: knowledge shared types and `db`.

- [x] **Step 1: Write failing preview and incremental import tests**

Cover:

```ts
expect(preview.headers).toEqual(["一级原因", "二级原因", "三级原因"]);
expect(preview.totalRows).toBe(3);
expect(preview.added).toBe(3);

await importKnowledgeWorkbook(firstImport);
const second = await previewKnowledgeImport(updatedPath, "updated.xlsx", sectionId, columns);
expect(second).toMatchObject({ added: 1, updated: 1, skipped: 1 });
expect(listKnowledgeItems(baseId)).toHaveLength(4);
```

Also test duplicate paths, blank rows, duplicate headers, no result column, and a configured parent-column violation.

- [x] **Step 2: Verify focused test failure**

Run: `npm test -- src/server/services/knowledge/knowledge-import-service.test.ts`

Expected: FAIL because import services are missing.

- [x] **Step 3: Implement focused repository functions**

```ts
export function listKnowledgeBases(sectionId: string): KnowledgeBase[];
export function getKnowledgeBase(id: string): KnowledgeBase | undefined;
export function upsertKnowledgeBase(input: KnowledgeBaseInput): KnowledgeBase;
export function deleteKnowledgeBase(id: string): void;
export function listKnowledgeItems(baseId: string, query?: KnowledgeItemQuery): KnowledgeItemPage;
export function getKnowledgeItem(id: string): KnowledgeItem | undefined;
export function upsertKnowledgeItem(input: KnowledgeItemInput): KnowledgeItem;
export function deleteKnowledgeItem(id: string): void;
```

Repository item writes must update the FTS row in the same transaction.

- [x] **Step 4: Implement workbook inspection and preview**

Use ExcelJS to:

- Select the first non-empty worksheet.
- Read the first non-empty row as headers.
- Trim headers and reject duplicates.
- Convert values to stable strings.
- Build `pathKey` from ordered `result` columns.
- Build weighted search text by repeating keyword and result values before description and examples.
- Return row-level errors without mutating the database.

- [x] **Step 5: Implement transactional incremental import**

Use `knowledge_base_id + path_key` lookup:

```ts
if (!existing) added += 1;
else if (stableJson(existing.values) === stableJson(row.values)) skipped += 1;
else updated += 1;
```

Insert an import history row and update `item_count` only after all item and FTS writes succeed.

- [x] **Step 6: Run tests**

Run: `npm test -- src/server/services/knowledge/knowledge-import-service.test.ts`

Expected: PASS.

---

### Task 3: Chinese Candidate Retrieval

**Files:**
- Create: `src/server/services/knowledge/knowledge-search-service.ts`
- Create: `src/server/services/knowledge/knowledge-search-service.test.ts`

**Interfaces:**
- Produces:

```ts
export interface KnowledgeSearchInput {
  knowledgeBaseId: string;
  query: string;
  limit?: number;
}
export function searchKnowledge(input: KnowledgeSearchInput): KnowledgeCandidate[];
```

- Consumes: enabled knowledge base/items and FTS table.

- [x] **Step 1: Write failing retrieval tests**

Seed paths including:

```ts
{ 一级原因: "工厂问题", 二级原因: "品质-面板故障", 三级原因: "弹簧片掉落" }
{ 一级原因: "工厂问题", 二级原因: "品质-漏气", 三级原因: "慢漏气" }
```

Assert that “客户说面板里面的弹簧片掉了” ranks the first path at position zero, disabled items are absent, and another section's item is absent.

- [x] **Step 2: Verify failure**

Run: `npm test -- src/server/services/knowledge/knowledge-search-service.test.ts`

Expected: FAIL because search is missing.

- [x] **Step 3: Implement FTS and fallback scoring**

Query FTS by base ID and use `bm25` for initial ranking. Merge with a bounded SQL `instr(search_text, ?)` fallback for short queries. Apply deterministic boosts:

```ts
score += resultValues.some((value) => query.includes(value)) ? 30 : 0;
score += keywords.filter((keyword) => query.includes(keyword)).length * 20;
score += normalizedSearchText.includes(normalizedQuery) ? 10 : 0;
```

Return stable item IDs, values, score, and matched text. Clamp limit to `5..30`, default `15`.

- [x] **Step 4: Run retrieval tests**

Run: `npm test -- src/server/services/knowledge/knowledge-search-service.test.ts`

Expected: PASS.

---

### Task 4: Knowledge Match Prompt And Snapshot Service

**Files:**
- Create: `src/server/ai/knowledge-match-prompt-builder.ts`
- Create: `src/server/ai/knowledge-match-prompt-builder.test.ts`
- Create: `src/server/services/knowledge/knowledge-match-service.ts`
- Create: `src/server/services/knowledge/knowledge-match-service.test.ts`

**Interfaces:**
- Produces:

```ts
export function buildKnowledgeMatchMessages(input: {
  sectionName: string;
  fieldPrompt: string;
  dependencies: Record<string, unknown>;
  candidates: KnowledgeCandidate[];
}): Array<{
  role: "system" | "user";
  content: string;
}>;

export async function matchKnowledgeItem(input: {
  recordId: string;
  field: AnalysisField;
  sectionName: string;
  dependencies: Record<string, unknown>;
}): Promise<KnowledgeMatchResult>;
```

- Consumes: `searchKnowledge`, text model config, OpenAI-compatible client.

- [x] **Step 1: Write failing prompt and selection validation tests**

Assert the prompt contains candidate IDs and values, does not include disabled/non-candidate rows, and requires:

```json
{"knowledgeItemId":"candidate-id"}
```

Assert an unknown ID returns `needs_review`, while an empty ID is a valid unmatched result requiring review.

- [x] **Step 2: Verify failure**

Run: `npm test -- src/server/ai/knowledge-match-prompt-builder.test.ts src/server/services/knowledge/knowledge-match-service.test.ts`

Expected: FAIL because builder and service are missing.

- [x] **Step 3: Implement prompt builder**

System message: select only from supplied candidate IDs and return legal JSON. User content includes field prompt, dependency JSON, and compact candidate JSON containing only ID and configured searchable/result columns.

- [x] **Step 4: Implement matching and immutable snapshot persistence**

Use `getModelForPurpose("text")`, call the existing OpenAI-compatible client, parse JSON, validate membership in the candidate set, and save:

```ts
{
  knowledgeItemId,
  itemValues: selected.values,
  candidates,
  query,
  rawResponse,
}
```

The returned field result is `{ [field.key]: knowledgeItemId }`; the full row remains in `knowledge_match_snapshots`.

- [x] **Step 5: Run tests**

Run: `npm test -- src/server/ai/knowledge-match-prompt-builder.test.ts src/server/services/knowledge/knowledge-match-service.test.ts`

Expected: PASS.

---

### Task 5: Field Execution Modes And Export Rules

**Files:**
- Modify: `src/server/services/field-config-service.ts`
- Modify: `src/server/services/field-config-service.test.ts`
- Create: `src/server/services/knowledge/knowledge-extract-service.ts`
- Create: `src/server/services/knowledge/knowledge-extract-service.test.ts`
- Modify: `src/server/services/field-analysis-service.ts`
- Modify: `src/server/services/field-analysis-service.test.ts`
- Modify: `src/server/services/excel-export-service.ts`
- Modify: `src/server/services/excel-export-service.test.ts`
- Modify: `src/server/services/excel-template-service.ts`

**Interfaces:**
- Produces:

```ts
export function extractKnowledgeValue(input: {
  recordId: string;
  matchFieldKey: string;
  knowledgeColumn: string;
  outputKey: string;
}): Record<string, string>;
```

- Consumes: match snapshots from Task 4.

- [x] **Step 1: Write failing graph, extraction, and export tests**

Test:

- `knowledge_extract` requires `matchFieldKey` and `knowledgeColumn`.
- Match fields require `knowledgeBaseId`.
- Extraction returns the selected row value or `""`.
- Three extraction fields read one snapshot.
- `exportEnabled: false` fields are absent from output plans.
- An AI image field uses vision, match field uses text, extraction uses no model.

- [x] **Step 2: Verify failure**

Run: `npm test -- src/server/services/field-config-service.test.ts src/server/services/field-analysis-service.test.ts src/server/services/knowledge/knowledge-extract-service.test.ts src/server/services/excel-export-service.test.ts`

Expected: FAIL on new execution behavior.

- [x] **Step 3: Extend field validation and persistence**

Map all new columns in `mapField` and `upsertField`. Add validation errors with exact messages:

```ts
if (field.executionType === "knowledge_match" && !field.knowledgeBaseId)
  errors.push(`知识匹配字段未选择知识库：${field.key}`);
if (field.executionType === "knowledge_extract" && (!field.matchFieldKey || !field.knowledgeColumn))
  errors.push(`知识提取字段配置不完整：${field.key}`);
```

Automatically include `matchFieldKey` in extraction dependencies.

- [x] **Step 4: Add execution dispatcher**

Refactor `runField` into a small dispatcher:

```ts
switch (field.executionType) {
  case "knowledge_match": return runKnowledgeMatch(...);
  case "knowledge_extract": return runKnowledgeExtract(...);
  default: return runAiField(...);
}
```

Select model per field instead of once per record. Extraction must not call `getModelForPurpose`.

- [x] **Step 5: Exclude internal fields**

Filter `exportEnabled` in `exportColumns`, output plan creation, and detail display data. Keep internal field runs visible only in diagnostic data.

- [x] **Step 6: Run focused tests**

Run the four focused test files from Step 2.

Expected: PASS.

---

### Task 6: Knowledge API Routes

**Files:**
- Create: `src/server/routes/knowledge-routes.ts`
- Create: `src/server/routes/knowledge-routes.test.ts`
- Modify: `src/server/app.ts`

**Interfaces:**
- Produces: the REST endpoints from the approved spec.
- Consumes: import, repository, and search services.

- [x] **Step 1: Write failing route tests**

Cover list, preview multipart upload, confirmed import, paginated item list, item edit/delete, base enable/disable/delete, and search test.

- [x] **Step 2: Verify failure**

Run: `npm test -- src/server/routes/knowledge-routes.test.ts`

Expected: FAIL with route 404 responses.

- [x] **Step 3: Implement an isolated router**

Export:

```ts
export function createKnowledgeRouter(upload: multer.Multer): express.Router;
```

Mount with `app.use("/api", createKnowledgeRouter(upload))`. Reuse the API response envelope `{ success, data, error }`.

- [x] **Step 4: Add upload lifecycle cleanup**

Preview uploads are deleted after inspection. Confirmed imports move the source file under the server data directory. Failed imports delete temporary uploads and preserve the prior database state.

- [x] **Step 5: Run route and full server tests**

Run: `npm test -- src/server/routes/knowledge-routes.test.ts`

Expected: PASS.

---

### Task 7: Knowledge Management UI

**Files:**
- Create: `src/client/api/knowledge-api.ts`
- Create: `src/client/components/knowledge/KnowledgeWorkspace.tsx`
- Create: `src/client/components/knowledge/KnowledgeBaseList.tsx`
- Create: `src/client/components/knowledge/KnowledgeImportDialog.tsx`
- Create: `src/client/components/knowledge/KnowledgeItemList.tsx`
- Create: `src/client/components/knowledge/KnowledgeItemEditor.tsx`
- Create: `src/client/components/knowledge/KnowledgeSearchTest.tsx`
- Create: `src/client/components/knowledge/KnowledgeWorkspace.test.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`

**Interfaces:**
- Produces: a section-scoped knowledge workspace with content, items, and search-test views.
- Consumes: Task 6 APIs and active section ID.

- [x] **Step 1: Write failing interaction tests**

Test that:

- Clicking a section's “知识库” action opens the current section workspace.
- Import preview renders added/updated/skipped/error counts.
- Item edit saves dynamic column values.
- Disabled items display a disabled state.
- Search test renders ranked candidates.

- [x] **Step 2: Verify failure**

Run: `npm test -- src/client/components/knowledge/KnowledgeWorkspace.test.tsx`

Expected: FAIL because components do not exist.

- [x] **Step 3: Implement typed API client**

Keep fetch wrappers out of components:

```ts
export const knowledgeApi = {
  listBases(sectionId: string): Promise<KnowledgeBase[]>,
  previewImport(sectionId: string, file: File, columns?: KnowledgeColumn[]): Promise<KnowledgeImportPreview>,
  confirmImport(sectionId: string, token: string, columns: KnowledgeColumn[]): Promise<KnowledgeImportResult>,
  listItems(baseId: string, query: KnowledgeItemQuery): Promise<KnowledgeItemPage>,
  search(baseId: string, query: string): Promise<KnowledgeCandidate[]>,
};
```

- [x] **Step 4: Implement workspace navigation**

Use a full workspace view instead of a nested modal. Preserve the existing task workspace state and add a back action. Tabs are `内容管理`, `知识条目`, and `检索测试`.

- [x] **Step 5: Implement import mapping**

After preview, show every Excel header with multi-role controls and parent-column validation selection. Persist and reuse returned column schema on later imports.

- [x] **Step 6: Implement item CRUD and search test**

Generate editor fields from `KnowledgeBase.columns`; do not hardcode reason levels. Use the existing styled confirmation dialog for deletion.

- [x] **Step 7: Add pixel-style responsive CSS**

Use full-width tables/bands, square controls, existing ink/green/cyan/orange variables, and no nested cards. On narrow screens, keep actions fixed and allow the dynamic item table to scroll horizontally.

- [x] **Step 8: Run UI tests and build**

Run: `npm test -- src/client/components/knowledge/KnowledgeWorkspace.test.tsx`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

---

### Task 8: Field Configuration UI For Knowledge Modes

**Files:**
- Modify: `src/client/components/FieldConfigEditor.tsx`
- Create: `src/client/components/KnowledgeFieldSettings.tsx`
- Modify: `src/client/components/SectionConfigDialog.tsx`
- Create: `src/client/components/FieldConfigEditor.test.tsx`
- Modify: `src/client/styles.css`

**Interfaces:**
- Produces: execution-type-specific field controls.
- Consumes: section knowledge bases and dynamic knowledge columns.

- [x] **Step 1: Write failing configuration tests**

Assert:

- AI mode shows prompt, image, required, and dependencies.
- Match mode shows knowledge base, candidate count, prompt, dependencies, and export toggle.
- Extract mode shows match source, knowledge column, and target Excel field; it hides prompt and image controls.
- Internal match field can save without an Excel output column.

- [x] **Step 2: Verify failure**

Run: `npm test -- src/client/components/FieldConfigEditor.test.tsx`

Expected: FAIL on missing controls.

- [x] **Step 3: Implement mode selector and focused settings component**

Use a segmented control with:

```ts
[
  ["ai", "AI 解析"],
  ["knowledge_match", "知识库匹配"],
  ["knowledge_extract", "知识结果提取"],
]
```

`KnowledgeFieldSettings` fetches bases only for knowledge modes and columns only after a base or match source is selected.

- [x] **Step 4: Update save payload and validation display**

Preserve inactive settings in state but send all typed properties. Show server validation errors in the existing pixel form error band.

- [x] **Step 5: Run tests**

Run: `npm test -- src/client/components/FieldConfigEditor.test.tsx`

Expected: PASS.

---

### Task 9: End-To-End Regression And Production Verification

**Files:**
- Create: `src/server/services/knowledge/knowledge-flow.integration.test.ts`
- Modify: `README.md`

**Interfaces:**
- Verifies all previous tasks as one working flow.

- [x] **Step 1: Add an integration test using a generated workbook**

The test imports a dynamic reason workbook, creates:

```text
截图解析 → 原因路径匹配 → 一级选项 / 二级选项 / 三级选项
```

Stub the model to choose the item whose values are:

```json
{
  "一级原因": "工厂问题",
  "二级原因": "品质-面板故障",
  "三级原因": "弹簧片掉落"
}
```

Assert one text-model call, no extraction-model calls, one shared snapshot, and the three exported cell values.

- [x] **Step 2: Run the integration test**

Run: `npm test -- src/server/services/knowledge/knowledge-flow.integration.test.ts`

Expected: PASS.

- [x] **Step 3: Run complete verification**

Run: `npm test`

Expected: all tests PASS.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [x] **Step 4: Verify the local application**

Start or reuse: `npm run dev`

Verify:

- `GET http://localhost:8787/api/health` returns status `ok`.
- Import `退货原因汇总.xlsx` into `退货分析`.
- The import preview reports 388 data rows.
- A search for “面板弹簧片掉落” returns the expected full path.
- The field configuration can create one internal match field and three extraction fields.
- Exported Excel includes the three result columns but excludes the internal field.

- [x] **Step 5: Document the operator workflow**

Document: create/open section knowledge base, import Excel, map dynamic columns, inspect preview, test retrieval, configure match/extract fields, run analysis, and export results.
