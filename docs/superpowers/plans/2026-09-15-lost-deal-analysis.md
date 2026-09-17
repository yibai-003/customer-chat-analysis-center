# 未成交分析板块优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a two-call未成交分析流程 with standard customer/call-center reason knowledge bases, local result extraction, and rule-first script suggestions.

**Architecture:** Keep screenshot transcription as a vision AI field. Add an internal object field that performs one text-model structured attribution using the two reason knowledge bases as controlled vocabularies. Derive public fields locally and generate default script suggestions from deterministic rules.

**Tech Stack:** TypeScript, React, SQLite, Zod, Vitest, ExcelJS, existing knowledge repository and field graph.

**Spec:** `docs/superpowers/specs/2026-09-15-lost-deal-analysis-design.md`

## Global Constraints

- Preserve existing public Excel headers and historical analysis results.
- Do not add model calls for each reason field.
- Only standard names from enabled knowledge items are accepted as classified reasons.
- Evidence must be present in the screenshot summary or source context.
- Use existing `knowledge/catalog.json` synchronization and database restore flow.
- Run focused tests before full typecheck/build.

### Task 1: Add failing attribution contract tests

**Files:**
- Create: `src/server/services/lost-deal-attribution.test.ts`
- Test: existing field execution tests if needed

- [ ] Add tests for parsing 1-2 customer reasons, 1-2 service reasons, and 1-2 demand objects.
- [ ] Add tests rejecting reason names outside supplied knowledge candidates.
- [ ] Add tests preserving `待复核` and evidence when confidence is insufficient.
- [ ] Run the focused test and verify it fails before implementation.

### Task 2: Implement attribution parsing and deterministic public-field derivation

**Files:**
- Create: `src/server/services/lost-deal-attribution.ts`
- Create: `src/server/services/lost-deal-script-rules.ts`
- Test: `src/server/services/lost-deal-attribution.test.ts`

- [ ] Define typed attribution input/output interfaces with arrays for reasons and demand types.
- [ ] Implement strict JSON parsing, count limits, allowed-name checks, evidence checks, and confidence validation.
- [ ] Implement local extraction of public `客户原因`, `客服原因`, and `客户产品需求` values using newline separators.
- [ ] Implement rule lookup for common customer/service reason combinations.
- [ ] Run focused tests and verify all pass.

### Task 3: Add the internal field execution path

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/server/ai/result-validator.ts` if object validation needs extension
- Modify: `src/server/services/field-analysis-service.ts`
- Modify: `src/server/ai/field-prompt-builder.ts` or add an attribution prompt builder
- Test: `src/server/services/field-analysis-service.test.ts`

- [ ] Add a dedicated execution branch for the `未成交归因` object field.
- [ ] Build one text-model request containing the screenshot summary and enabled customer/service knowledge candidates.
- [ ] Persist one field run with the complete structured result and evidence.
- [ ] Derive public fields without additional model calls.
- [ ] Ensure field failures/skips use existing status aggregation.
- [ ] Add a test proving one vision call plus one text call for the full chain.
- [ ] Run the focused field tests and verify no additional reason-matching calls occur.

### Task 4: Seed and synchronize the two knowledge bases

**Files:**
- Modify: `knowledge/catalog.json`
- Modify: `src/server/db/seed.ts` if new environments need seed defaults
- Create or modify: knowledge service tests

- [ ] Add the customer reason knowledge base with the confirmed initial categories and metadata columns.
- [ ] Add the customer-service reason knowledge base with the confirmed initial categories and improvement metadata.
- [ ] Add the internal `未成交归因` field and update existing field dependencies/configuration.
- [ ] Keep public output columns and disable export for the internal field.
- [ ] Restore the catalog into the local database and verify existing data remains intact.

### Task 5: Add rule-first script suggestion behavior

**Files:**
- Modify: `src/server/services/lost-deal-script-rules.ts`
- Modify: `src/server/services/field-analysis-service.ts`
- Test: `src/server/services/lost-deal-attribution.test.ts`

- [ ] Generate a deterministic suggestion from customer/service reason pairs.
- [ ] Return a concise one-sentence suggestion with no model call.
- [ ] Return a safe review message when both reasons are missing or marked for review.
- [ ] Add tests for price, product-fit, service-response, and unknown combinations.

### Task 6: Verify integration and compatibility

**Files:**
- Modify: relevant integration tests only if required

- [ ] Run lost-deal focused tests.
- [ ] Run the existing hot-topic and field-analysis focused tests.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `npm run db:check`.
- [ ] Verify the public field outputs and internal field export behavior with an Excel integration test.
- [ ] Review `git diff` to confirm unrelated boards were not changed.
