# Task 9 Report: Explicit Batch Paid-Token Controls

Date: 2026-09-16
Worktree: `E:\客服解析中心\.worktrees\model-pool`
Branch: `feat/model-pool`

## Implemented

- Added the `最大付费 Token` numeric control to `AnalysisRunDialog`.
- Initialized the control to `0`.
- Added `min="0"`, `max="100000000"`, and `step="1000"`.
- Added the required free-pool pause warning:
  `0 表示仅使用免费池；免费额度不可用时任务暂停并等待处理。`
- Rejected empty, negative, fractional, and out-of-range client values before confirmation.
- Forwarded `maxPaidTokens` through the App/controller payload.
- Forwarded the exact analyze-route option object:
  `{ concurrency, batchSize, maxPaidTokens }`.
- Normalized server input to safe integers from `0` through `100000000`; invalid values default to `0`.
- Wrapped the prepared `analyzeJob()` batch in one root `withPaidTokenBudget` context.
- Preserved existing per-field `withModelBudget` limits.
- Preserved Task 7's `createModelPoolRouter()` mount.

## TDD Evidence

### RED

Command:

```powershell
npx vitest run src/client/components/AnalysisRunDialog.test.tsx src/server/services/batch-analysis-service.test.ts --pool=threads --maxWorkers=1
```

Initial result:

- Failed 6 tests.
- Dialog failed because `最大付费 Token` was absent and the submitted options lacked `maxPaidTokens`.
- Resolver failed because `maxPaidTokens` was absent.
- Analyze API forwarding failed because the route omitted `maxPaidTokens`.

After the first implementation pass, the remaining failures were only matcher setup issues in the new dialog assertions (`toHaveTextContent` was unavailable in this test file). The assertions were changed to use `textContent`, then the suite passed.

## GREEN Verification

Focused Task 9 and model-pool regression suite:

```powershell
npx vitest run src/client/components/AnalysisRunDialog.test.tsx src/client/App.test.tsx src/server/services/batch-analysis-service.test.ts src/server/services/model-pool-service.test.ts --pool=threads --maxWorkers=1
```

Result: **4 test files passed, 85 tests passed.**

Typecheck:

```powershell
npm run typecheck
```

Result: **passed** (`tsc --noEmit`).

Diff whitespace check:

```powershell
git diff --check
```

Result: **passed**. Git only reported the repository's existing LF/CRLF normalization warnings.

## Self-Review

- Paid-token default is fail-closed at both client and server boundaries.
- Server normalization accepts `0`, `100000000`, and intermediate safe integers; invalid values become `0`.
- Route forwarding contains exactly `concurrency`, `batchSize`, and `maxPaidTokens`.
- The paid budget wraps the prepared batch once at the `analyzeJob()` root.
- Existing field-level model request and timeout budgets were not modified.
- The Task 7 model-pool router mount remains present.
- No runtime dependency, schema, credential, logging, or model-pool policy changes were introduced.
- One additional source file, `src/client/hooks/useWorkspaceController.ts`, was required because the existing local option type otherwise failed typecheck.
- One directly related existing integration assertion, `src/client/App.test.tsx`, was updated because it asserted the pre-Task-9 request shape.

## Commit

Implementation commit: `6fe2ab0` (`feat: require explicit paid model budget`)

## Concerns

- The broader repository test suite was not run; verification covered the affected client integration, dialog, batch-service, and model-pool suites plus typecheck.
- Retry-failed keeps its existing no-options API and therefore remains fail-closed for paid routing through the existing model-pool behavior; Task 9's explicit paid budget applies to the batch analyze flow.
