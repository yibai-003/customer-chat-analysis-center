# Reception Quality Performance Baseline Plan

> **Issue:** GitHub #4, https://github.com/yibai-003/customer-chat-analysis-center/issues/4
> **Spec:** `E:/客服解析中心工单草稿/issue-reception-performance.md`
> **Related guides:** `docs/guides/reception-xlsx-release-gate.md`, `docs/guides/large-file-processing-flow.md`, `docs/guides/xlsx-resource-validation.md`, `docs/guides/upload-safety.md`, `docs/guides/cancellation-and-model-budget.md`

**Goal:** Produce privacy-safe, repeatable timing evidence for reception quality stages without changing scoring, model routing, prompts, or concurrency.

**Baseline boundary:** The available release-gate fixture is generated and model calls are stubbed. It can measure import, field orchestration, local derivation, export, and mock-model overhead only. It cannot establish real provider latency or qualify a production speed improvement.

### Task 1: Capture a Safe Synthetic Baseline

**Files:**
- Modify: `src/server/services/reception-xlsx-release-gate.integration.test.ts`
- Add: `docs/superpowers/plans/2026-09-26-reception-performance-baseline.md`

- [x] Assert the automated report includes sample provenance, concurrency, task and field-stage timings, throughput, model-attempt counts, failures, rate limits/timeouts, and an explicit mocked-model marker.
- [x] Verify the integration test fails because the benchmark report is absent.
- [x] Generate a fixed-fixture benchmark report using only existing timing and model-attempt metadata. Do not include record/source content, images, payloads, credentials, cookies, or logs.
- [x] Repeat the same automated fixture five times and summarize the synthetic local baseline.

Five runs on the same generated four-record fixture, concurrency 1:

| Run | Analysis wall time | Throughput |
| --- | ---: | ---: |
| 1 | 277 ms | 14.44 records/s |
| 2 | 234 ms | 17.09 records/s |
| 3 | 231 ms | 17.32 records/s |
| 4 | 255 ms | 15.69 records/s |
| 5 | 256 ms | 15.63 records/s |

Median wall time was 255 ms; median throughput was 15.69 records/s. Across runs, screenshot-facts field p50/p95 was 1/3 ms, quality-analysis field p50 was 2 ms with p95 4-5 ms, and rule-derivation p95 was 0-1 ms. The eight model attempts per run are mocked and typically report 1 ms each. These numbers describe only local orchestration against generated input; they do not measure provider, network, or real-image latency.

### Task 2: Decide Whether Local Optimization Is Evidence-Based

- [x] Compare per-field elapsed time against model-attempt durations to identify local versus external time; the generated fixture shows no meaningful local derivation bottleneck.
- [x] Keep existing stage-reuse behavior and scoring/result contracts under the reception XLSX gate.
- [x] No runtime optimization was justified by the mocked fixture. Real provider latency and any speed-improvement claim still require an approved anonymized workbook and fixed provider configuration; keep Issue #4 open.
- [x] Run the focused service tests, reception XLSX gate, typecheck, lint, and build.

### Acceptance

- Automated measurements are repeatable and explicitly scoped to generated input and stubbed model calls.
- No business output, request routing, prompt, or concurrency setting changes without evidence.
- No GitHub Issue closure, commit, push, or merge.
