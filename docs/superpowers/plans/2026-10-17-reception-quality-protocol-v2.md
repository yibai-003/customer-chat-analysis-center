# 接待质检 V2 规则覆盖与证据链 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 发布一个向后兼容的接待质检 V2 配置版本，保证完整规则覆盖、合法且可审计的知识/证据上下文，并在缺少后台凭证时自动转人工复核。

**Architecture:** 保留 legacy 和现有 strict 解析链路不变，在服务层增加由版本快照中的 `businessRules.analysisProtocol = "v2"` 选择的 V2 提示词与解析器。V2 将规则判定统一为逐规则状态和结构化证据引用；本地仍负责扣分、等级、D 级、标签和建议。迁移 030 只追加一个不可变的已发布接待版本并更新运行时投影，历史任务继续使用自己的版本快照。

**Tech Stack:** TypeScript, Zod, Vitest, SQLite append-only migrations, React/Vite existing workspace styles.

**Spec:** `docs/work-items/reception-quality-protocol-v2/spec.md`

## Global Constraints

- 不新增工作簿中的后台登记、备注、补发、退款或投诉凭证列，也不改变接待 XLSX 导入/导出契约。
- V2 提示词始终发送任务绑定版本的完整规则目录；不得使用 `sceneHints` 预先删掉售前或售后规则。
- 知识上下文只能在完整知识库边界内纳入，序列化结果必须始终是可解析 JSON；任何省略都要进入人工复核。
- `dialogue`、`source_field`、`knowledge`、`backend_record` 是唯一允许的证据来源；当前没有后端凭证输入，`backend_record` 不得产生确定合规或违规结论。
- 扣分、维度、D 级、等级、标签和建议只由任务绑定版本的本地规则派生，模型不能返回或覆盖这些结果。
- migration 030 必须 append-only、可重复执行、保留旧版本和历史分析结果；schema 版本由 29 递增为 30。
- 不提高并发、不更换模型、不以删减规则缩短提示词；性能问题继续由 Issue #4 跟踪。
- 不提交、推送、合并或创建 PR；遵循仓库 AGENTS.md，所有改动保持未提交供用户审核。
- `src/client/workspace-theme.css` 与 `src/client/workspace-style-contracts.test.ts` 在主工作区已有的“中间区域自然滚动、页码可见”未提交改动属于用户已有改动；本计划不覆盖或回退它们，交付前只在主工作区运行其回归测试。

## File Map

- Create `src/server/services/reception-knowledge-context.ts`: boundary-safe knowledge snapshot packing and omission metadata.
- Create `src/server/services/reception-quality-v2-prompts.ts`: V2 screenshot-facts and quality prompt constants.
- Create `src/server/db/migrations/030-reception-quality-protocol-v2.ts`: append-only current-version migration.
- Modify `src/server/services/reception-quality-rules.ts`: evidence-source vocabulary and immutable V2 rule enrichment.
- Modify `src/server/services/section-business-rules.ts` and `src/server/security/configuration-input.ts`: protocol and evidence-source contracts.
- Modify `src/server/services/reception-quality.ts`: shared protocol types, boundary-safe wrapper, V2 response schema, prompt builder, parser, and structured issue evidence.
- Modify `src/server/services/execution/reception-quality.ts`: select V2 by the bound version snapshot and pass all evidence inputs to the parser.
- Modify `src/server/services/section-config-version-service.ts`: validate V2 evidence-source metadata without requiring unavailable backend columns.
- Modify `src/server/db/migrations/index.ts`, `src/server/db/migrations/migrations.lock.json`, and `src/server/db/migrations/migrations.test.ts`: register and certify schema 30.
- Modify `src/server/services/reception-quality.test.ts`, `src/server/services/section-config-version-service.test.ts`, and `src/server/services/reception-xlsx-release-gate.integration.test.ts`: TDD coverage for prompts, parsing, immutable versions, retries, rollback, and export.

---

### Task 1: Add versioned protocol and evidence-source contracts

**Files:**
- Modify: `src/server/services/reception-quality-rules.ts`
- Modify: `src/server/services/section-business-rules.ts`
- Modify: `src/server/security/configuration-input.ts`
- Test: `src/server/services/reception-quality.test.ts`
- Test: `src/server/security/configuration-input.test.ts`

**Interfaces:**
- Add `export const RECEPTION_EVIDENCE_SOURCES = ["dialogue", "source_field", "knowledge", "backend_record"] as const` and `export type ReceptionEvidenceSource = (typeof RECEPTION_EVIDENCE_SOURCES)[number]`.
- In `src/server/services/section-business-rules.ts`, add `export type ReceptionQualityProtocol = "legacy" | "strict" | "v2"` and add the optional `analysisProtocol` property to `ReceptionBusinessRules`.
- Extend `ReceptionIssueRule` with `evidenceSources?: ReceptionEvidenceSource[]`; the property remains optional for old snapshots.
- Extend `ReceptionBusinessRules` with `analysisProtocol?: ReceptionQualityProtocol`.
- Add `export function receptionV2IssueRules(): ReceptionIssueRule[]`, returning fresh rule objects and never mutating `RECEPTION_ISSUE_RULES`.

The V2 enrichment must use explicit ID groups. Rules not in a group default to `["dialogue"]`; the following groups are mandatory:

```ts
const knowledgeRuleIds = new Set([
  "PRE_FALSE_PROMOTION",
  "PRE_PRODUCT_KNOWLEDGE_ERROR",
  "PRE_CAMPAIGN_ERROR",
  "PRE_BUSINESS_RULE_ERROR",
  "POST_BAD_PROCESS_OR_PRIVACY",
  "POST_SOP_VIOLATION",
]);
const backendRuleIds = new Set([
  "POST_NO_REGISTRATION",
  "POST_NO_NOTE",
  "POST_NO_RESEND",
  "POST_REGISTRATION_ERROR",
  "POST_CHAT_CAUSED_COMPLAINT",
  "POST_REFUND_COMPLAINT_ERROR",
  "POST_REFUND_REJECT_NO_EVIDENCE",
]);
const sourceFieldRuleIds = new Set(["PRE_NO_ORDER_GUIDANCE"]);
```

Each grouped rule keeps `dialogue` and adds its listed source; `POST_BAD_PROCESS_OR_PRIVACY` and `POST_SOP_VIOLATION` therefore require `dialogue + knowledge`, while backend rules require `dialogue + backend_record`. `PRE_NO_ORDER_GUIDANCE` requires `dialogue + source_field`. This makes the absence of backend data explicit without inventing workbook fields.

- [ ] **Step 1: Write failing contract tests.**

```ts
it("builds V2 evidence metadata without changing the legacy rule catalog", () => {
  const legacy = receptionBusinessRules(sectionBusinessRules("reception")).issues;
  const v2 = receptionV2IssueRules();
  expect(v2).not.toBe(legacy);
  expect(v2.find((rule) => rule.id === "POST_NO_REGISTRATION")?.evidenceSources)
    .toEqual(["dialogue", "backend_record"]);
  expect(v2.find((rule) => rule.id === "PRE_ANSWER_IRRELEVANT")?.evidenceSources)
    .toEqual(["dialogue"]);
  expect(legacy.find((rule) => rule.id === "POST_NO_REGISTRATION")?.evidenceSources)
    .toBeUndefined();
});
```

```ts
it("accepts only the declared V2 protocol and evidence sources", () => {
  expect(() => parseConfiguration(receptionBusinessRulesInput, {
    ...sectionBusinessRules("reception"),
    analysisProtocol: "v2",
    issues: receptionV2IssueRules(),
  })).not.toThrow();
  expect(() => parseConfiguration(receptionBusinessRulesInput, {
    ...sectionBusinessRules("reception"),
    analysisProtocol: "v2",
    issues: [{ ...receptionV2IssueRules()[0], evidenceSources: ["remote_database"] }],
  })).toThrow("配置参数无效");
});
```

- [ ] **Step 2: Run the focused tests and verify they fail for the missing protocol/source properties.**

Run: `npm test -- src/server/services/reception-quality.test.ts src/server/security/configuration-input.test.ts`

Expected: FAIL because the new evidence-source exports and `analysisProtocol` schema are not implemented yet.

- [ ] **Step 3: Implement the smallest contract change.**

Add the constants/types, the explicit ID-group mapper, the optional protocol field to the reception business-rule Zod schema, and the optional `evidenceSources` field with duplicate prevention to `receptionIssueRuleInput`. Keep `sectionBusinessRules("reception")` protocol-less so old V1/V4/V5 snapshots continue to route through the existing strict path.

- [ ] **Step 4: Run the focused tests and the existing reception parser tests.**

Run: `npm test -- src/server/services/reception-quality.test.ts src/server/security/configuration-input.test.ts`

Expected: PASS, with the old test fixtures still parsing because protocol/source metadata is optional outside V2.

### Task 2: Make knowledge context boundary-safe

**Files:**
- Create: `src/server/services/reception-knowledge-context.ts`
- Modify: `src/server/services/reception-quality.ts`
- Test: `src/server/services/reception-knowledge-context.test.ts`
- Test: `src/server/services/reception-quality.test.ts`

**Interfaces:**
- Create:

```ts
export interface ReceptionKnowledgeContext {
  serialized: string;
  complete: boolean;
  includedBaseIds: string[];
  omittedBaseIds: string[];
  omittedItemCount: number;
}

export function buildReceptionKnowledgeContext(
  snapshot: SectionConfigVersion["knowledgeSnapshot"] | undefined,
  maxChars?: number,
): ReceptionKnowledgeContext;
```

- The serialized item shape is exactly `{ baseId, name, items: [{ itemId, values }] }`.
- Only enabled bases and enabled items with object `values` are candidates.
- Pack complete bases in snapshot order. Add a base only when `JSON.stringify([...included, candidate])` is within `maxChars` (default `20_000`); if a base does not fit, omit the whole base and count all of its eligible items. Never slice a string and never append a non-JSON truncation marker.
- Keep `receptionKnowledgeSnapshotContext(snapshot)` in `reception-quality.ts` as a compatibility wrapper returning `buildReceptionKnowledgeContext(snapshot).serialized`, so legacy/strict callers receive valid JSON without changing their function signature.

- [ ] **Step 1: Write failing boundary tests.**

```ts
it("omits whole bases at the budget boundary and always returns legal JSON", () => {
  const context = buildReceptionKnowledgeContext([
    {
      id: "small-base", name: "小库", isEnabled: true,
      items: [{ id: "small-item", isEnabled: true, values: { rule: "keep" } }],
    },
    {
      id: "large-base", name: "大库", isEnabled: true,
      items: [{ id: "large-item", isEnabled: true, values: { rule: "x".repeat(200) } }],
    },
  ] as any, 120);

  expect(() => JSON.parse(context.serialized)).not.toThrow();
  expect(JSON.parse(context.serialized)).toEqual([
    { baseId: "small-base", name: "小库", items: [{ itemId: "small-item", values: { rule: "keep" } }] },
  ]);
  expect(context.complete).toBe(false);
  expect(context.omittedBaseIds).toEqual(["large-base"]);
  expect(context.omittedItemCount).toBe(1);
});
```

```ts
it("keeps the compatibility wrapper parseable for oversized snapshots", () => {
  const serialized = receptionKnowledgeSnapshotContext([{
    id: "oversized", name: "超大库", isEnabled: true,
    items: [{ id: "item", isEnabled: true, values: { text: "y".repeat(25_000) } }],
  }] as any);
  expect(() => JSON.parse(serialized)).not.toThrow();
  expect(serialized).not.toContain("截断");
});
```

- [ ] **Step 2: Run the new tests and confirm the current string-slice implementation fails.**

Run: `npm test -- src/server/services/reception-knowledge-context.test.ts src/server/services/reception-quality.test.ts`

Expected: FAIL because the helper does not exist and the current wrapper emits invalid JSON for oversized snapshots.

- [ ] **Step 3: Implement the atomic packing helper and wrapper.**

Use `JSON.stringify` only after the candidate list is selected. Preserve IDs so V2 evidence references can be checked against the bound snapshot. Return `complete: true` for an empty or fully included snapshot; return `false` whenever one enabled base is omitted.

- [ ] **Step 4: Run the focused tests and existing prompt tests.**

Run: `npm test -- src/server/services/reception-knowledge-context.test.ts src/server/services/reception-quality.test.ts`

Expected: PASS, including all existing strict prompt tests.

### Task 3: Implement the V2 response schema, prompt builder, and parser

**Files:**
- Create: `src/server/services/reception-quality-v2-prompts.ts`
- Modify: `src/server/services/reception-quality.ts`
- Test: `src/server/services/reception-quality.test.ts`

**Interfaces:**
- Add `ReceptionQualityAnalysis.analysisProtocol = "v2"` to the existing union and add `evidenceRefs?: ReceptionV2EvidenceRef[]` to `ReceptionIssue` without changing export columns.
- Add:

```ts
export type ReceptionV2RuleStatus = "violation" | "compliant" | "needs_review" | "not_applicable";

export interface ReceptionV2EvidenceRef {
  source: ReceptionEvidenceSource;
  id: string;
  quote?: string;
  value?: string;
}

export interface ReceptionV2RuleCheck {
  ruleId: string;
  status: ReceptionV2RuleStatus;
  evidence: ReceptionV2EvidenceRef[];
  evidenceExplanation: string;
  reason: string;
}

export function buildReceptionQualityV2Messages(input: {
  field: AnalysisField;
  screenshotFacts: unknown;
  sourceFields: Record<string, string>;
  businessRules?: Record<string, unknown>;
  knowledgeSnapshot?: SectionConfigVersion["knowledgeSnapshot"];
}): Array<{ role: "system" | "user"; content: unknown }>;

export function parseReceptionQualityV2(
  raw: string,
  options: {
    screenshotFacts?: unknown;
    sourceFields?: Record<string, string>;
    knowledgeSnapshot?: SectionConfigVersion["knowledgeSnapshot"];
    businessRules?: Record<string, unknown>;
  },
): ReceptionQualityAnalysis;
```

- The strict V2 response root is exactly `{ scene, checkedRuleIds, ruleChecks, blockingUnverifiableItems, informationalUnverifiableItems, confidence }`. The model contract requires one `ruleChecks` entry for every rule in the bound catalog. In a pure `售前` scene, after-sale entries are `not_applicable`; in `售后`, pre-sale entries are `not_applicable`; in `混合` and `无法判断`, every rule is applicable. `checkedRuleIds` must equal the complete set of non-`not_applicable` IDs. At runtime, missing rule checks or a mismatched `checkedRuleIds` set become a blocking review item with no deterministic issue; unknown or duplicate IDs remain hard parse errors.
- Each V2 rule check uses `evidence` refs. A `dialogue` ref must name an existing turn and its `quote` must be contained in that turn's text. A `source_field` ref must name a field returned by `receptionAiSourceFields(sourceFields)` and its `value` must equal the original value. A `knowledge` ref must use `baseId/itemId` and its `value` must equal `JSON.stringify(item.values)` for an included enabled item. `backend_record` is syntactically recognized for auditability but is always unavailable in this task and forces `needs_review`.
- A `violation` is accepted only when its rule is applicable, all blocking evidence sources declared by the rule are available, and at least one valid dialogue ref exists. Invalid/unknown refs, an unavailable blocking source, or an applicable rule marked `not_applicable` produce a blocking review item and no deterministic issue. Informational missing sources are recorded in `informationalUnverifiableItems`.
- `compliant` is also downgraded to `needs_review` when a blocking source is unavailable; this prevents a missing backend record from becoming a false compliance result. `needs_review` never contributes a deduction. Local score/grade/labels/suggestions are derived from accepted violations through the existing rule catalog.
- A V2 knowledge context includes the `ReceptionKnowledgeContext` status in the prompt. `complete === false` automatically adds a blocking review item during parsing, using the same bound snapshot and 20,000-character budget.

- [ ] **Step 1: Write failing V2 parser and prompt tests.**

```ts
it.each([
  ["售前", ["PRE_ANSWER_IRRELEVANT", "POST_NO_REPLY"]],
  ["售后", ["PRE_ANSWER_IRRELEVANT", "POST_NO_REPLY"]],
  ["混合", ["PRE_ANSWER_IRRELEVANT", "POST_NO_REPLY"]],
  ["无法判断", ["PRE_ANSWER_IRRELEVANT", "POST_NO_REPLY"]],
] as const)("V2 prompt keeps the complete catalog when sceneHints is %s", (hint, sentinels) => {
  const text = JSON.stringify(buildReceptionQualityV2Messages({
    field: qualityField(),
    screenshotFacts: { ...completeFacts(), sceneHints: [hint] },
    sourceFields: {},
  }));
  for (const id of sentinels) expect(text).toContain(id);
  expect(text).toContain("完整规则目录");
});
```

```ts
function completeV2RuleChecks(
  rules: ReceptionBusinessRules,
  scene: ReceptionScene,
  override: Pick<ReceptionV2RuleCheck, "status">,
): ReceptionV2RuleCheck[] {
  return rules.issues.map((rule) => ({
    ruleId: rule.id,
    status: scene === "混合" || scene === "无法判断"
      || (scene === "售前" && rule.scope === "preSale")
      || (scene === "售后" && rule.scope === "afterSale")
      ? override.status
      : "not_applicable",
    evidence: [],
    evidenceExplanation: "受控测试证据说明",
    reason: "受控测试判定理由",
  }));
}

it("rejects incomplete V2 coverage and invalid evidence instead of scoring an issue", () => {
  const raw = JSON.stringify({
    scene: "售前",
    checkedRuleIds: ["PRE_ANSWER_IRRELEVANT"],
    ruleChecks: [{
      ruleId: "PRE_ANSWER_IRRELEVANT",
      status: "violation",
      evidence: [{ source: "dialogue", id: "T99", quote: "不存在的原文" }],
      evidenceExplanation: "无法回溯",
      reason: "无法回溯",
    }],
    blockingUnverifiableItems: [],
    informationalUnverifiableItems: [],
    confidence: 0.9,
  });
  const result = parseReceptionQualityV2(raw, { screenshotFacts: completeFacts(), sourceFields: {} });
  expect(result.preSaleIssues).toEqual([]);
  expect(result.totalDeduction).toBe(0);
  expect(result.reviewRequired).toBe(true);
  expect(result.unverifiableItems).toEqual(expect.arrayContaining([
    expect.stringContaining("规则覆盖不完整"),
    expect.stringContaining("证据"),
  ]));
});
```

```ts
it("downgrades backend-dependent compliant/violation checks when the workbook has no backend credentials", () => {
  const v2Rules = {
    ...canonicalRules,
    analysisProtocol: "v2" as const,
    issues: receptionV2IssueRules(),
  };
  const checks = completeV2RuleChecks(v2Rules, "售后", { status: "compliant" });
  const result = parseReceptionQualityV2(JSON.stringify({
    scene: "售后",
    checkedRuleIds: v2Rules.issues.filter((rule) => rule.scope === "afterSale").map((rule) => rule.id),
    ruleChecks: checks,
    blockingUnverifiableItems: [],
    informationalUnverifiableItems: [],
    confidence: 0.9,
  }), {
    screenshotFacts: completeFacts(),
    sourceFields: {},
    businessRules: v2Rules as unknown as Record<string, unknown>,
  });
  expect(result.afterSaleIssues).toEqual([]);
  expect(result.reviewRequired).toBe(true);
  expect(result.unverifiableItems).toEqual(expect.arrayContaining([
    expect.stringContaining("后台"),
  ]));
});
```

The test helper `completeV2RuleChecks` must create one explicit check for every catalog rule, set the requested status only on applicable rules, use `not_applicable` for the other scope, and include a valid `T2` dialogue ref for a deliberate violation. It must not bypass the parser's coverage validation.

- [ ] **Step 2: Run the focused tests and verify failures.**

Run: `npm test -- src/server/services/reception-quality.test.ts`

Expected: FAIL because the V2 prompt constants, schema, prompt builder, parser, and evidence checks do not exist.

- [ ] **Step 3: Implement V2 prompts and parser.**

`RECEPTION_V2_SCREENSHOT_FACTS_PROMPT` keeps the existing objective fact-extraction contract and states that `sceneHints` is advisory only. `RECEPTION_V2_QUALITY_PROMPT` explicitly requires the four statuses, complete rule coverage, exact evidence-reference formats, no historical result columns, and no model scoring.

In `reception-quality.ts`, reuse `parseJsonObject`, `schemaError`, `calculateGrade`, `expectedRuleIds`, and local issue ordering where possible. Extract or export only the helpers needed by V2; do not alter the old `qualityResponseSchema` or `parseReceptionQuality` behavior. Preserve normalized structured evidence on accepted issues as `evidenceRefs`, and include those refs in the execution evidence text without adding an XLSX column.

- [ ] **Step 4: Run V2 and legacy reception tests.**

Run: `npm test -- src/server/services/reception-quality.test.ts src/server/services/reception-quality-legacy.test.ts`

Expected: PASS. The tests must prove both that V2 sees both scopes regardless of `sceneHints` and that old strict/legacy fixtures still use their original schemas.

### Task 4: Route the bound version through V2 while preserving local derivation

**Files:**
- Modify: `src/server/services/execution/reception-quality.ts`
- Modify: `src/server/services/reception-quality.ts`
- Test: `src/server/services/reception-quality.test.ts`
- Test: `src/server/services/field-analysis-service.test.ts`

**Interfaces:**
- Change the internal `ReceptionSource` to carry `analysisProtocol: ReceptionQualityProtocol` and `knowledgeSnapshot: SectionConfigVersion["knowledgeSnapshot"]`.
- In `prepare`, select `"v2"` only when `receptionBusinessRules(configVersion.businessRules).analysisProtocol === "v2"`; otherwise retain the current strict detection based on the screenshot-facts field, and use legacy only when that field is absent.
- In `buildMessages`, dispatch to `buildReceptionQualityV2Messages` for V2, `buildReceptionQualityMessages` for old strict, and `buildLegacyReceptionQualityMessages` for legacy.
- In `parse`, pass `sourceFields` and `knowledgeSnapshot` to `parseReceptionQualityV2`; old parsers receive their existing options unchanged.
- Keep `deriveReceptionQualityFields` and the existing `status` callback shared. V2 review flags must produce `status: "needs_review"`; accepted violations must still use local configured deductions and grade thresholds.

- [ ] **Step 1: Add a routing regression test before changing the handler.**

Add a field-analysis test fixture whose `SectionConfigVersion.businessRules` includes `{ kind: "reception_quality", analysisProtocol: "v2", ... }`, whose controlled text response uses `ruleChecks`, and whose screenshot facts contain only `sceneHints: ["售前"]`. Assert that the run completes through the V2 parser, stores `analysisProtocol: "v2"`, and derives the configured local deduction rather than a model-supplied value.

- [ ] **Step 2: Run the focused field-analysis test and verify the V2 fixture is rejected by the old dispatcher.**

Run: `npm test -- src/server/services/field-analysis-service.test.ts src/server/services/reception-quality.test.ts`

Expected: FAIL until the protocol selection and V2 parser dispatch are implemented.

- [ ] **Step 3: Implement protocol selection and input propagation.**

Do not infer the protocol from prompt text, current live configuration, task name, or `sceneHints`; use the task's immutable `configVersion.businessRules` snapshot only. Keep model retry validation and the local derive handler on the same bound version.

- [ ] **Step 4: Run the routing and parser tests.**

Run: `npm test -- src/server/services/field-analysis-service.test.ts src/server/services/reception-quality.test.ts src/server/services/reception-quality-legacy.test.ts`

Expected: PASS with old strict and legacy fixtures unchanged and V2 output marked for review whenever its evidence chain is incomplete.

### Task 5: Publish V2 as append-only migration 030 and validate its snapshot

**Files:**
- Create: `src/server/db/migrations/030-reception-quality-protocol-v2.ts`
- Modify: `src/server/db/migrations/index.ts`
- Modify: `src/server/db/migrations/migrations.lock.json`
- Modify: `src/server/db/migrations/migrations.test.ts`
- Modify: `src/server/services/section-config-version-service.ts`
- Modify: `src/server/services/section-config-version-service.test.ts`
- Test: `src/server/services/reception-xlsx-release-gate.integration.test.ts`

**Interfaces:**
- Create `export function applyReceptionQualityProtocolV2(db: any): void`.
- Register it as `{ version: 30, name: "reception-quality-protocol-v2", up: applyReceptionQualityProtocolV2 }` and set `currentSchemaVersion = 30`.
- The migration must be idempotent: no reception section/current version is a no-op; a current snapshot with `businessRules.analysisProtocol === "v2"` is a no-op; otherwise it creates exactly one next version.

Migration algorithm:

1. Read the current published reception version and its JSON snapshots. Fail clearly if either core field (`截图内容总结`, `统一质检分析`) is missing.
2. Clone the section snapshot, export settings, dependencies, and knowledge snapshot unchanged. Replace only the two core field prompts with `RECEPTION_V2_SCREENSHOT_FACTS_PROMPT` and `RECEPTION_V2_QUALITY_PROMPT`; keep their existing IDs, execution types, image flags, dependency, and result fields.
3. Set `businessRules.analysisProtocol = "v2"` and `businessRules.issues = receptionV2IssueRules()`. Do not alter the old row's JSON.
4. Mark the old current version non-current, insert a new `published` current row with `version_number = max + 1`, and write an audit event with `upgrade: "reception-quality-protocol-v2"`.
5. Update the live `analysis_sections` and the two live core `analysis_fields` to mirror the new current projection, matching the existing migration pattern. Do not update or delete any historical version row.

Validation changes in `section-config-version-service.ts`:

- When `analysisProtocol === "v2"`, require every issue to contain a non-empty, duplicate-free `evidenceSources` list whose values are in `RECEPTION_EVIDENCE_SOURCES`.
- Permit `backend_record` as a declared requirement; do not require a corresponding workbook column.
- Continue enforcing all existing rule, import-contract, two-stage dependency, and export-contract checks.

- [ ] **Step 1: Add migration and validation tests before implementation.**

```ts
it("creates one immutable V2 reception version from schema 29", () => {
  applyLegacyBaseline(db);
  runMigrations(db, migrations.filter((migration) => migration.version <= 29));
  const before = db.prepare(`SELECT id, business_rules_json, fields_snapshot_json
    FROM analysis_section_versions WHERE section_id = 'reception' AND is_current = 1`).get();
  migrations.find((migration) => migration.version === 30)!.up(db);
  const current = db.prepare(`SELECT version_number, business_rules_json
    FROM analysis_section_versions WHERE section_id = 'reception' AND is_current = 1`).get() as any;
  expect(current.version_number).toBe((before as any).version_number + 1);
  expect(JSON.parse(current.business_rules_json).analysisProtocol).toBe("v2");
  expect(db.prepare(`SELECT business_rules_json FROM analysis_section_versions WHERE id = ?`)
    .get((before as any).id).business_rules_json).toBe((before as any).business_rules_json);
  migrations.find((migration) => migration.version === 30)!.up(db);
  expect(db.prepare(`SELECT COUNT(*) count FROM analysis_section_versions
    WHERE section_id = 'reception' AND is_current = 1`).get()).toEqual({ count: 1 });
});
```

```ts
it("rejects a V2 snapshot with an unknown evidence source", () => {
  const draft = createDraftVersion("reception");
  const rules = structuredClone(draft.businessRules) as any;
  rules.analysisProtocol = "v2";
  rules.issues[0].evidenceSources = ["remote_database"];
  expect(() => updateDraftSectionVersion(draft.id, { businessRules: rules })).toThrow("配置参数无效");
});
```

- [ ] **Step 2: Run migration and config tests to confirm failures.**

Run: `npm test -- src/server/db/migrations/migrations.test.ts src/server/services/section-config-version-service.test.ts`

Expected: FAIL because schema 30, migration 030, V2 snapshot validation, and lock entry are absent.

- [ ] **Step 3: Implement migration 030 and validation.**

Use `crypto.randomUUID()` for the new version ID, `new Date().toISOString()` for timestamps, and the existing `analysis_section_versions`/`audit_events` SQL shape. Update all hard-coded migration expectations from 29 to 30 only where they describe the supported current schema; tests that intentionally build a schema-29 baseline must continue to do so.

- [ ] **Step 4: Recompute the migration lock from the final file contents.**

Run: `(Get-FileHash src/server/db/migrations/030-reception-quality-protocol-v2.ts -Algorithm SHA256).Hash.ToLower()`

Expected: add the resulting lowercase SHA-256 under key `030-reception-quality-protocol-v2.ts` in `src/server/db/migrations/migrations.lock.json`; do not change existing hash entries.

- [ ] **Step 5: Run migration/config tests.**

Run: `npm test -- src/server/db/migrations/migrations.test.ts src/server/db/migrations/migrations-immutability.test.ts src/server/services/section-config-version-service.test.ts`

Expected: PASS, including idempotence, append-only history, lock verification, schema version 30, and rejection of invalid V2 evidence metadata.

### Task 6: Update the controlled XLSX release gate for V2 and prove rollback/retry isolation

**Files:**
- Modify: `src/server/services/reception-xlsx-release-gate.integration.test.ts`
- Modify: `src/server/services/reception-quality.test.ts` if a shared V2 response helper is extracted there

**Interfaces:**
- Change the controlled text response helper from `preSaleIssues`/`afterSaleIssues` to the V2 root with one `ruleChecks` entry per version rule. Keep deliberate violations as `status: "violation"` with valid T2 refs and all other applicable rules as `status: "compliant"` only when the test version contains a synthetic complete knowledge snapshot. Use `status: "needs_review"` for a backend-dependent after-sale check to prove the no-backend-column rule.
- Add a small complete synthetic knowledge base to the new V2 test version's `knowledgeSnapshot` so knowledge-dependent pre-sale checks can be deterministic in the controlled gate; do not add any workbook columns.
- Select the historical strict version explicitly from the published reception versions whose `businessRules.analysisProtocol` is absent, while treating the migration-created current version as V2. Assert the imported task binds the V2 version, stores the V2 protocol, retains the version/knowledge/rule hashes after retry, and leaves that historical strict version's deduction behavior unchanged after rollback.

- [ ] **Step 1: Add the V2 controlled-response fixture and assertions.**

The fixture must derive `checkedRuleIds` from the bound version's rule catalog, emit `not_applicable` for the opposite scope, and include valid evidence refs. Add assertions for:

```ts
expect(getJobSectionConfigVersion(taskOne.id)?.businessRules).toMatchObject({ analysisProtocol: "v2" });
expect(qualityResult(byOrder.get("RG-SINGLE")!.id)).toMatchObject({
  labels: ["答非所问"], deductions: [17], reviewRequired: false,
});
expect(qualityResult(byOrder.get("RG-REVIEW")!.id).reviewRequired).toBe(true);
expect(getJobSectionConfigVersion(taskOne.id)?.id).toBe(newVersion.id);
```

- [ ] **Step 2: Run the release gate and observe failures from the old response shape/current expectations.**

Run: `npm run test:reception-xlsx`

Expected: FAIL until the fixture emits V2 responses and the migration-created current version is handled.

- [ ] **Step 3: Implement the controlled V2 response helper and update only affected expected counts.**

Keep the test's historical rollback assertions: after activating the explicitly selected pre-V2 strict version, the old task must still parse its old response schema and use its old deduction (10 instead of the new V2 version's configured 17). Keep export, formula, image, conflict, and conversation-ID assertions unchanged.

- [ ] **Step 4: Run the focused release gate and automated gate script.**

Run: `npm run test:reception-xlsx`

Expected: PASS.

Run: `npm run gate:reception-xlsx`

Expected: PASS with only generated ignored artifacts; no real business workbook is read unless an explicitly supplied release-gate environment variable is present.

### Task 7: Verify the complete change and the existing pagination fix

**Files:**
- No new production files; preserve the parent workspace changes in `src/client/workspace-theme.css` and `src/client/workspace-style-contracts.test.ts`.
- Test: parent workspace `src/client/workspace-style-contracts.test.ts`

- [ ] **Step 1: Run focused server tests after all tasks.**

Run:

```powershell
npm test -- src/server/services/reception-quality.test.ts
npm test -- src/server/services/reception-quality-legacy.test.ts
npm test -- src/server/services/section-config-version-service.test.ts
npm test -- src/server/db/migrations/migrations.test.ts
npm run test:reception-xlsx
```

Expected: all commands PASS.

- [ ] **Step 2: Run the client pagination/style regression test from the main workspace.**

Run from `E:\客服解析中心` (not the isolated worktree, because the CSS/test edits predate this plan):

```powershell
npm test -- src/client/workspace-style-contracts.test.ts
```

Expected: PASS, including the contract that `.workspace` and `.content` do not trap `.record-pager` in a fixed-height middle panel.

- [ ] **Step 3: Run repository-wide verification.**

Run:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npm run db:check
npm run gate:reception-xlsx
```

Expected: all commands PASS. If `db:check` or a release/manual Excel/WPS check is unavailable, record the exact command, exit code, and environment blocker instead of weakening tests or claiming success.

- [ ] **Step 4: Review the final diff and working-tree ownership.**

Run: `git diff --check; git status --short`

Expected: no whitespace errors; the isolated worktree contains only the planned protocol/migration/test/docs changes, while the parent retains its two pre-existing frontend files untouched. Do not commit or create a PR.

## Self-Review Checklist

- **Spec coverage:** Task 1 covers explicit evidence sources; Task 2 covers valid boundary-safe knowledge JSON and omission review; Task 3 covers complete rule states, scene-hint independence, evidence validation, and local scoring; Task 4 covers version-bound routing and retries; Task 5 covers immutable migration 030 and old-version preservation; Task 6 covers no-backend-column behavior and XLSX rollback/export; Task 7 covers the user-visible pagination regression and full verification.
- **Placeholder scan:** no step relies on “TBD”, “TODO”, “implement later”, or an unspecified test. Every named helper, type, migration, and command is defined above.
- **Type consistency:** `ReceptionQualityProtocol`, `ReceptionEvidenceSource`, `ReceptionKnowledgeContext`, `ReceptionV2EvidenceRef`, `ReceptionV2RuleCheck`, `buildReceptionKnowledgeContext`, `buildReceptionQualityV2Messages`, `parseReceptionQualityV2`, and `applyReceptionQualityProtocolV2` are the exact names used across tasks.

