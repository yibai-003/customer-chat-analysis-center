# Task 10 Migration Critical Fix Report

Date: 2026-09-16
Worktree: `E:\客服解析中心\.worktrees\model-pool`

## Fixed Critical

Migration 14 previously assigned every legacy DashScope model to the hard-coded
`provider-dashscope` provider and copied one model's ciphertext into that
provider. Models using different legacy API keys could therefore be silently
mixed.

The migration now creates or reuses providers by the exact pair:

```text
base_url + api_key_ciphertext
```

Consequences:

- Legacy models with the same URL and ciphertext reuse one provider.
- Legacy models with different ciphertexts receive different providers.
- Legacy models with different URLs receive different providers, even when
  their ciphertext is identical.
- Each model is bound to a provider containing its own original URL and
  ciphertext.
- DashScope providers retain the `千问百炼` display name without changing the
  grouping rule.

## Compatibility and Security

- Existing `model_configs.base_url` and `model_configs.api_key_ciphertext`
  columns are preserved and remain readable.
- Provider IDs are deterministic SHA-256-derived identifiers over the URL and
  ciphertext pair.
- The migration does not decrypt, log, or return complete API keys.
- `INSERT OR IGNORE`, deterministic IDs, and existing provider assignments
  keep repeated application idempotent.
- No runtime dependency or unrelated file was changed.

## TDD Evidence

### RED

The regression test was changed first to cover shared credentials, distinct
credentials, and distinct URLs. Before the migration fix it failed with:

```text
AssertionError: expected 'provider-dashscope' not to be 'provider-dashscope'
```

This demonstrated that models with different DashScope ciphertexts were still
being merged.

### GREEN

After the migration change:

```text
npx vitest run src/server/db/migrations/migrations.test.ts --pool=threads --maxWorkers=1
Test Files  1 passed (1)
Tests       10 passed (10)
```

TypeScript verification:

```text
npm run typecheck
tsc --noEmit: passed
```

Diff whitespace verification:

```text
git diff --check: passed
```

## Changed Files

- `src/server/db/migrations/014-model-pools.ts`
- `src/server/db/migrations/migrations.test.ts`
- `task-10-fix-migration-report.md`
