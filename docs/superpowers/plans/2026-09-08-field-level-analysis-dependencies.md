# 字段级解析与依赖链 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前板块级 AI 解析升级为字段级提示词、字段级图片开关和字段依赖链，支持“截图内容 -> 一级原因 -> 二级原因”的顺序解析，并兼容历史板块配置与导出结果。

**Architecture:** 保留 `analysis_sections` 作为板块容器，新建 `analysis_fields` 保存每个字段的提示词、类型、图片开关和依赖 Key；新建 `analysis_field_runs` 保存每条记录每个字段的独立解析快照和结果。服务端构建字段依赖图，校验循环依赖后按拓扑顺序逐字段调用 OpenAI 兼容接口，最终将字段结果聚合为前端详情和 Excel 导出数据。

**Tech Stack:** React + TypeScript, Express, SQLite/better-sqlite3, Vitest, ExcelJS, OpenAI-compatible Chat Completions API.

**Spec:** `docs/superpowers/specs/2026-09-08-customer-chat-excel-analysis-design.md`

## Global Constraints

- 单用户本地部署，不引入登录、权限和队列集群。
- API Key 只在服务端解密和发送，前端只接收脱敏值。
- 每个字段解析必须保存提示词、字段定义、依赖输入和模型快照。
- 单字段失败不能阻塞无依赖字段；依赖失败的字段应标记为 failed/needs_review 并说明上游失败。
- 历史 `outputSchema` 字段没有独立提示词时，字段提示词默认继承板块提示词。
- 依赖关系必须是有向无环图；禁止自依赖、重复 Key 和跨板块依赖。
- 现有旧版 `analysis_runs` 数据必须可继续查看和导出。
- 每个任务遵循 TDD：先写失败测试，再写最小实现。
- 完成前运行 `npm test`、`npm run typecheck`、`npm run build` 并进行浏览器验证。

---

### Task 1: Shared Types and Database Migration

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/server/db/client.ts`
- Create: `src/server/services/field-config-service.ts`
- Test: `src/server/services/field-config-service.test.ts`

**Interfaces:**
- `AnalysisField`: `{ id, sectionId, key, label, type, prompt, required, imageEnabled, dependsOn }`
- `AnalysisFieldRun`: `{ id, recordId, fieldId, status, result, rawResponse?, errorMessage?, dependencies, createdAt }`
- `listFields(sectionId: string): AnalysisField[]`
- `upsertField(input: AnalysisFieldInput): AnalysisField`
- `deleteField(id: string): void`
- `validateFieldGraph(fields: AnalysisField[]): string[]`
- `topologicalFields(fields: AnalysisField[]): AnalysisField[]`
- `migrateLegacySectionFields(): void`

- [ ] **Step 1: Write failing migration and graph tests**

Test these exact behaviors:

```ts
it("migrates legacy output schema fields into field configs", () => {
  initDb();
  const fields = listFields("reception");
  expect(fields.find((field) => field.key === "conclusion")?.prompt).toContain("问候");
  expect(fields.find((field) => field.key === "conclusion")?.imageEnabled).toBe(true);
});

it("orders dependent fields after their dependencies", () => {
  const fields = [
    field("reason", ["screenshotContent"]),
    field("screenshotContent", []),
  ];
  expect(topologicalFields(fields).map((item) => item.key)).toEqual(["screenshotContent", "reason"]);
});

it("rejects circular dependencies", () => {
  expect(() => topologicalFields([
    field("a", ["b"]),
    field("b", ["a"]),
  ])).toThrow("循环依赖");
});
```

- [ ] **Step 2: Run the targeted test and confirm it fails**

Run:

```text
npm test -- src/server/services/field-config-service.test.ts
```

Expected: FAIL because the field table and graph service do not exist.

- [ ] **Step 3: Add the database tables and migration**

Add:

```sql
CREATE TABLE IF NOT EXISTS analysis_fields (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL,
  prompt TEXT NOT NULL,
  is_required INTEGER NOT NULL DEFAULT 0,
  image_enabled INTEGER NOT NULL DEFAULT 1,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(section_id, key),
  FOREIGN KEY(section_id) REFERENCES analysis_sections(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS analysis_field_runs (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT NOT NULL,
  dependencies_json TEXT NOT NULL,
  prompt_snapshot TEXT NOT NULL,
  field_snapshot_json TEXT NOT NULL,
  model_config_snapshot_json TEXT NOT NULL,
  raw_response TEXT,
  error_message TEXT,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE,
  FOREIGN KEY(field_id) REFERENCES analysis_fields(id) ON DELETE CASCADE
);
```

On startup, migrate each legacy `output_schema_json` entry into `analysis_fields` once. Use the section prompt as the field prompt, section `imageEnabled` as the field image setting, and an empty dependency list.

- [ ] **Step 4: Implement graph validation and field CRUD**

Implement strict same-section dependency validation, stable sort order, default prompt inheritance, and topological ordering with a clear error for missing dependencies, duplicate keys, self-dependencies, and cycles.

- [ ] **Step 5: Run the targeted test and typecheck**

Run:

```text
npm test -- src/server/services/field-config-service.test.ts
npm run typecheck
```

Expected: PASS.

### Task 2: Field-Level Prompt Construction and Result Persistence

**Files:**
- Modify: `src/server/ai/prompt-builder.ts`
- Modify: `src/server/ai/result-validator.ts`
- Modify: `src/server/db/repositories.ts`
- Create: `src/server/ai/field-prompt-builder.ts`
- Create: `src/server/services/field-run-service.ts`
- Test: `src/server/ai/field-prompt-builder.test.ts`
- Test: `src/server/services/field-run-service.test.ts`

**Interfaces:**
- `buildFieldMessages(input: FieldPromptInput): VisionMessage[]`
- `createFieldRun(input: CreateFieldRunInput): AnalysisFieldRun`
- `listFieldRuns(recordId: string, sectionId?: string): AnalysisFieldRun[]`
- `getFieldResultContext(recordId: string, fieldKeys: string[]): Record<string, unknown>`
- `aggregateFieldResults(recordId: string, sectionId: string): Record<string, unknown>`

- [ ] **Step 1: Write failing field prompt tests**

Assert:

```ts
it("sends only the target field schema and dependency values", () => {
  const messages = buildFieldMessages({
    field: field("一级原因", "根据截图内容判断一级原因", ["screenshotContent"], false),
    sectionName: "未成交分析",
    sourceFields: { 渠道: "微信" },
    dependencyResults: { screenshotContent: "客户询问价格后离开" },
    imageDataUrl: "",
  });
  const serialized = JSON.stringify(messages);
  expect(serialized).toContain("一级原因");
  expect(serialized).toContain("客户询问价格后离开");
  expect(serialized).not.toContain("image_url");
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```text
npm test -- src/server/ai/field-prompt-builder.test.ts src/server/services/field-run-service.test.ts
```

Expected: FAIL because field prompt construction and field run persistence do not exist.

- [ ] **Step 3: Implement field prompt construction**

Build a JSON-only prompt containing:

```text
解析板块
目标字段
字段说明
辅助字段
依赖字段结果
只输出目标字段 Key
```

Append `image_url` only when `field.imageEnabled` is true and the model supports vision.

- [ ] **Step 4: Add field run repository functions**

Persist independent field runs with the exact field snapshot, prompt snapshot, dependency result snapshot, model snapshot, raw response, usage, duration and status. Aggregate the latest successful/needs-review field result by field Key for the record detail and export layer.

- [ ] **Step 5: Run targeted tests and typecheck**

Run:

```text
npm test -- src/server/ai/field-prompt-builder.test.ts src/server/services/field-run-service.test.ts
npm run typecheck
```

Expected: PASS.

### Task 3: Dependency-Aware Analysis Executor

**Files:**
- Create: `src/server/services/field-analysis-service.ts`
- Modify: `src/server/services/analysis-service.ts`
- Modify: `src/server/services/batch-analysis-service.ts`
- Modify: `src/server/app.ts`
- Test: `src/server/services/field-analysis-service.test.ts`

**Interfaces:**
- `analyzeRecordFields(recordId: string, sectionId: string): Promise<FieldBatchProgress>`
- `analyzeField(recordId: string, sectionId: string, fieldKey: string): Promise<AnalysisFieldRun>`
- `retryField(recordId: string, sectionId: string, fieldKey: string): Promise<AnalysisFieldRun>`
- `FieldBatchProgress`: `{ total, completed, failed, needsReview, skipped }`

- [ ] **Step 1: Write failing dependency execution tests**

Use a deterministic runner to prove:

```ts
it("runs screenshot content before dependent reason", async () => {
  const order: string[] = [];
  const result = await executeFieldGraph(fields, async (field, context) => {
    order.push(field.key);
    if (field.key === "reason") expect(context.screenshotContent).toBe("聊天内容");
    return { [field.key]: field.key === "screenshotContent" ? "聊天内容" : "价格原因" };
  });
  expect(order).toEqual(["screenshotContent", "reason"]);
  expect(result.reason).toBe("价格原因");
});

it("skips a dependent field when its dependency failed", async () => {
  const result = await executeFieldGraph(fields, async (field) => {
    if (field.key === "screenshotContent") throw new Error("图片解析失败");
    return {};
  });
  expect(result.reason.status).toBe("skipped");
});
```

- [ ] **Step 2: Run the targeted test and confirm it fails**

Run:

```text
npm test -- src/server/services/field-analysis-service.test.ts
```

Expected: FAIL because the dependency executor does not exist.

- [ ] **Step 3: Implement the topological field executor**

For each record:

1. Load enabled fields for the selected section.
2. Validate and topologically sort the field graph.
3. Read the record image once only for fields with `imageEnabled`.
4. Before each field, load dependency results from the current execution context.
5. Call the field runner with only that field's schema.
6. Save a field run.
7. Mark dependents as skipped when a dependency is failed or skipped.
8. Aggregate all field results to the record result view.

Keep the existing section-level endpoint as a compatibility wrapper that calls `analyzeRecordFields`.

- [ ] **Step 4: Add field-level routes**

Add:

```text
GET /api/sections/:id/fields
POST /api/sections/:id/fields
PATCH /api/fields/:id
DELETE /api/fields/:id
POST /api/records/:id/analyze-field
POST /api/jobs/:id/analyze
```

The existing batch endpoint accepts `sectionId` and runs the dependency graph for every record with bounded concurrency.

- [ ] **Step 5: Run targeted tests and full server tests**

Run:

```text
npm test -- src/server/services/field-analysis-service.test.ts
npm test
```

Expected: PASS.

### Task 4: Field Configuration UI

**Files:**
- Modify: `src/client/components/SectionConfigDialog.tsx`
- Create: `src/client/components/FieldConfigEditor.tsx`
- Create: `src/client/components/DependencySelect.tsx`
- Modify: `src/client/components/Modal.tsx`
- Modify: `src/client/styles.css`
- Test: `src/client/components/FieldConfigEditor.test.tsx`

**Interfaces:**
- `FieldConfigEditor` receives `fields`, `onChange`, `onSave`, `onError`.
- `DependencySelect` only lists fields from the current section and excludes the current field.

- [ ] **Step 1: Write failing UI behavior tests**

Test that:

```tsx
it("edits a field prompt and selects dependency fields", () => {
  render(<FieldConfigEditor fields={fields} onChange={onChange} />);
  expect(screen.getByLabelText("字段提示词")).toBeInTheDocument();
  expect(screen.getByLabelText("依赖字段")).toBeInTheDocument();
});
```

Also test that the current field cannot select itself and that image parsing is controlled per field.

- [ ] **Step 2: Run the targeted UI test and confirm it fails**

Run:

```text
npm test -- src/client/components/FieldConfigEditor.test.tsx
```

Expected: FAIL because the field editor component does not exist.

- [ ] **Step 3: Implement the field editor**

Replace the flat schema display with a structured editor:

```text
字段名称
字段 Key
字段类型
字段提示词
图片解析开关
必填开关
依赖字段多选
删除
```

Show dependency labels and display a clear validation message before save if a cycle or invalid dependency exists.

- [ ] **Step 4: Wire section configuration to field APIs**

Load fields for the selected section from `/api/sections/:id/fields`, save field changes through field routes, and keep the section prompt as the legacy fallback only. Do not store new field configuration back into `outputSchema` after migration.

- [ ] **Step 5: Run targeted UI tests and build**

Run:

```text
npm test -- src/client/components/FieldConfigEditor.test.tsx
npm run typecheck
npm run build
```

Expected: PASS.

### Task 5: Record Detail, Batch Progress, and Export Compatibility

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/server/app.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/server/services/excel-export-service.ts`
- Modify: `src/client/styles.css`
- Test: `src/server/services/excel-export-service.test.ts`

**Interfaces:**
- `RecordDetail.fieldRuns: AnalysisFieldRun[]`
- `GET /api/records/:id` returns aggregated field results and field runs.
- `flattenAnalysisColumns(jobId: string, sectionIds: string[]): ExportColumn[]`

- [ ] **Step 1: Write failing export and detail tests**

Assert that a record with `screenshotContent` and dependent `reason` exports both columns, uses field results, and preserves legacy section runs if no field runs exist.

- [ ] **Step 2: Run targeted tests and confirm failure**

Run:

```text
npm test -- src/server/services/excel-export-service.test.ts
```

Expected: FAIL because export still reads only section-level `analysisRuns`.

- [ ] **Step 3: Update record detail aggregation**

Return field runs and a merged result map. The detail pane renders fields in dependency order, shows field-level statuses, and allows retrying a failed field without re-running unrelated fields.

- [ ] **Step 4: Update batch progress UI**

Show field-level progress in the existing task status area:

```text
已完成字段 / 总字段
失败字段
跳过字段
```

Keep the current record-level filters and job-level status labels.

- [ ] **Step 5: Update export**

For each selected section, load field configs in sort order and append `${section.name}_${field.label}` columns. Prefer the latest human result, then field run result, then legacy section run result. Add field parsing status to the existing status metadata without overwriting source columns.

- [ ] **Step 6: Run full verification**

Run:

```text
npm test
npm run typecheck
npm run build
```

Expected: all tests pass and the production bundle builds.

### Task 6: Browser Verification and Migration Review

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-08-customer-chat-excel-analysis-design.md`
- Modify: `docs/superpowers/plans/2026-09-08-field-level-analysis-dependencies.md`

- [ ] **Step 1: Start or restart the development server**

Run:

```text
npm run dev
```

Verify `GET http://localhost:8787/api/health` returns HTTP 200.

- [ ] **Step 2: Verify the dependency workflow in the browser**

1. Open 板块配置.
2. Select 未成交分析.
3. Add or confirm `截图内容`, `一级原因`, and `二级原因`.
4. Give each field a different prompt.
5. Enable image parsing only for `截图内容`.
6. Set `一级原因` dependency to `截图内容`.
7. Run a record analysis.
8. Confirm field execution order and dependent context.
9. Retry only a failed field.

- [ ] **Step 3: Verify legacy compatibility**

Open an existing section created before migration and confirm its old output fields appear as editable field configs with inherited prompts and image settings.

- [ ] **Step 4: Verify export**

Export a job and inspect that field-level columns, original source fields, and original images remain present.

- [ ] **Step 5: Run final verification**

Run:

```text
npm test
npm run typecheck
npm run build
```

Expected: all checks pass.
