# Task 5 Report: Route Field, Lost-Deal, and Reception-Quality Analysis

Date: 2026-09-16

## Status

Implemented Task 5 on `feat/model-pool`, based on `7335efb`.

Commit:

- `7fe7668 refactor: route analysis through model pool`

The implementation is limited to the binding Task 5 production service and its field-analysis integration test:

- `src/server/services/field-analysis-service.ts`
- `src/server/services/field-analysis-service.test.ts`

The existing parser-focused coverage in these listed Task 5 test files remained valid and required no source changes:

- `src/server/services/lost-deal-attribution.test.ts`
- `src/server/services/reception-quality.test.ts`

No Task 6 files were modified.

## TDD Evidence

The router-based field-analysis test was written first and the required focused command failed because production still used `getModelsForPurpose` and `callVisionModel`.

Initial RED result:

```text
Test Files  1 failed | 2 passed (3)
Tests       5 failed | 25 passed (30)
```

The failures covered:

- image and text fields not calling `callModelPool`;
- lost-deal and reception-quality paths not supplying parser validators;
- router metadata not being persisted;
- router failures not being exercised by the field service.

An additional red-green cycle covered invalid structured output. The mock invokes the real validator callback and throws `ModelPoolError("invalid_output")`; the failed field run must retain the last invalid model content and route attempts.

## Implementation

### Unified Routing

Removed all direct model candidate loops, `getModelsForPurpose` calls, `checkModelBudget` calls, and `callVisionModel` calls from `field-analysis-service.ts`.

The three model-executing paths now call:

```ts
callModelPool(messages, {
  purpose,
  recordId,
  fieldId: field.id,
  operation,
});
```

Routing metadata is:

- image AI field: `purpose: "vision"`;
- text AI field: `purpose: "text"`;
- lost-deal attribution: `purpose: "text"`;
- reception-quality analysis: `purpose: "text"`;
- every route receives `recordId`, `fieldId`, and the field execution type.

### Parsing and Review Semantics

Generic AI fields still run `validateFieldResult` after routing. Invalid business field results retain the existing `needs_review` behavior and are not treated as provider failures.

Lost-deal and reception-quality calls pass parser-backed `validate` callbacks to the router:

- parser exceptions return `{ valid: false }`, enabling the router's controlled retry/switch policy;
- successfully parsed low-confidence, unsupported-evidence, incomplete-coverage, or otherwise reviewable business results return `{ valid: true }`;
- those valid business results are parsed again after routing and retain their existing `needs_review` status and messages.

### Persistence

Successful routed runs preserve:

- parsed result and evidence;
- status and error message;
- final raw provider response;
- prompt and field snapshots;
- prompt/completion token usage;
- duration;
- selected model snapshot;
- complete route attempts.

The new model snapshot format is:

```json
{
  "id": "selected-model-id",
  "name": "Selected model",
  "model": "provider-model-name",
  "purpose": "vision-or-text",
  "attempts": []
}
```

When the router rejects all parser-invalid structured responses, the failed run retains the last invalid model content and the attempts carried by `ModelPoolError`.

Lost-deal reason-link replacement remains transactional with field-run creation. Derived fields, local script rules, local reception-quality derivation, knowledge matching, knowledge extraction, and hot-topic dispatch were not changed.

## Verification

Required focused suite using the binding single-fork options:

```powershell
npx vitest run src/server/services/field-analysis-service.test.ts src/server/services/lost-deal-attribution.test.ts src/server/services/reception-quality.test.ts --pool=forks --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=1
```

Final result:

```text
Test Files  3 passed (3)
Tests       30 passed (30)
```

TypeScript:

```powershell
npm run typecheck
```

Result: passed with exit code 0.

Source audit:

- no `getModelsForPurpose` remains in `field-analysis-service.ts`;
- no `callVisionModel` remains in `field-analysis-service.ts`;
- no hand-written candidate loop remains in `field-analysis-service.ts`;
- `git diff --check` passed.

## Full-Suite Result and Concerns

The full suite was run with single-fork options:

```powershell
npm test -- --pool=forks --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=1
```

Result:

```text
Test Files  4 failed | 65 passed (69)
Tests       9 failed | 488 passed (497)
Errors      1 unhandled rejection
```

The failures are stale out-of-scope tests that still mock the old direct transport or rely on the old field-analysis bypass:

- `src/server/services/knowledge/hot-topic-service.test.ts`
- `src/server/services/knowledge/knowledge-flow.integration.test.ts`
- `src/server/services/analysis-cancellation.integration.test.ts`
- `src/server/services/record-retry-status.test.ts`

Updating those files would violate the corrected Task 5 boundary. Task 6 must migrate the knowledge/hot-topic callers and their tests. The remaining integration and retry-status tests also need their field-analysis dependency mocks changed from `callVisionModel` to `callModelPool` in their owning task.

The carry-forward production bypass is therefore only partially closed by design: Task 5 closes `field-analysis-service.ts`; Task 6 remains responsible for `knowledge-match-service.ts` and `hot-topic-service.ts`.

## Fix Round 1

Date: 2026-09-16

Updated the two stale Task 5 regression tests to mock the unified `callModelPool` boundary instead of the removed `getModelsForPurpose` / `callVisionModel` path. Cancellation, pause, late-response rejection, retry locking, sibling field status, and field-run count assertions remain in place. No Task 6 production or test files were modified.

Commit:

- `c5e506b test: update field analysis router mocks`

### RED Evidence

Command:

```powershell
npx vitest run src/server/services/analysis-cancellation.integration.test.ts src/server/services/record-retry-status.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism
```

Result before the fix:

```text
Test Files  2 failed (2)
Tests       7 failed | 1 passed (8)
Errors      1 unhandled rejection
```

The cancellation tests timed out because their `fetch` controls no longer intercepted field analysis after Task 5 moved the model call behind `callModelPool`. The retry-status cases returned `failed` because their old model-config and transport mocks were no longer used.

### GREEN Evidence

Affected tests:

```powershell
npx vitest run src/server/services/analysis-cancellation.integration.test.ts src/server/services/record-retry-status.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism
```

```text
Test Files  2 passed (2)
Tests       8 passed (8)
```

Task 5 focused suite:

```powershell
npx vitest run src/server/services/field-analysis-service.test.ts src/server/services/lost-deal-attribution.test.ts src/server/services/reception-quality.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism
```

```text
Test Files  3 passed (3)
Tests       30 passed (30)
```

TypeScript:

```powershell
npm run typecheck
```

Result: passed with exit code 0.

### Changed Files

- `src/server/services/analysis-cancellation.integration.test.ts`
- `src/server/services/record-retry-status.test.ts`
- `.superpowers/sdd/2026-09-16-model-pool/task-5-report.md`

## Fix Round 2

Date: 2026-09-16

The late-success router mock now returns a successful result after the active cancellation signal aborts. It does not throw on abort. The test retains the committed first field and checks that no completed second-field run is persisted. It also checks that the service does not even attempt a second `createFieldRun` call: the existing `assertRecordOwnership` inside that function already rejects canceled writes, so a persistence-only assertion was initially green without the new service guard.

### RED Evidence

After removing the mock's abort throw, the persistence-only late-success test passed (1 passed, 4 skipped). This exposed the pre-existing repository guard. With an attempted-write assertion added, the focused test failed against the unguarded service:

```text
Test Files  1 failed (1)
Tests       1 failed | 4 skipped (5)
AssertionError: expected "vi.fn()" to be called 1 times, but got 2 times
```

Command:

```powershell
npx vitest run src/server/services/analysis-cancellation.integration.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism -t "rejects a late response"
```

### GREEN Evidence

Added `assertAnalysisActive()` directly after `callModelPool` returns in generic AI, lost-deal attribution, and reception-quality analysis, before their parsing and persistence. The focused late-success test passed (1 passed, 4 skipped). The existing pause test continues to allow the in-flight record to finish.

Restored a real stalled HTTP response test in `analysis-cancellation.integration.test.ts`. It configures an enabled, capability-eligible free text pool member, invokes the real `callModelPool` implementation through field analysis, cancels the job, and observes the server response stream close. It asserts one request, a canceled job, released run token, and no processing or persisted field runs in either record. The other cancellation tests retain their controlled router mock.

Affected plus Task 5 focused tests:

```powershell
npx vitest run src/server/services/analysis-cancellation.integration.test.ts src/server/services/record-retry-status.test.ts src/server/services/field-analysis-service.test.ts src/server/services/lost-deal-attribution.test.ts src/server/services/reception-quality.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism
```

```text
Test Files  5 passed (5)
Tests       39 passed (39)
```

`npm run typecheck` and `git diff --check` passed.

### Concerns

The late-success regression checks the generic AI field directly; the identical post-return guard in the two structured paths is covered by their existing normal-path Task 5 tests, not separate cancellation fixtures. The router itself can still account a success if a transport resolves after abort before its own return; this round only changes field-run persistence and leaves router accounting outside Task 5 scope.
