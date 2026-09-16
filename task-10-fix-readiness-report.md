# Task 10 Readiness Important Fix Report

Date: 2026-09-16
Worktree: `E:\客服解析中心\.worktrees\model-pool`
Base HEAD: `244aac8`

## Fixed Important Issues

### Configured capability TTL

Server-side capability freshness no longer uses a fixed 24-hour constant.
Both public model mapping and readiness verification now read
`model_pool_settings.capability_ttl_ms`.

This keeps:

- model pool routing eligibility;
- model pool UI capability status;
- legacy readiness verification;
- `/api/ready` pool readiness

on the same persisted TTL setting.

### Pool-aware readiness

`/api/ready` now checks vision and text independently against the current
model pool.

When a purpose has one or more `pool_enabled` members, readiness requires at
least one member that is currently schedulable:

- the model is enabled and remains in the pool;
- the linked provider is enabled;
- capability checks passed and remain within the configured TTL;
- the member is a general routing member;
- cooldown has elapsed;
- free quota has not expired, been exhausted, or reached its safety limit.

Pool membership is detected before filtering blocked members. Therefore a
disabled, stale, exhausted, expired, cooling, or provider-disabled pool member
cannot cause readiness to fall back to an unrelated legacy default.

When a purpose has no pool members, the existing purpose-default selection and
verification behavior remains available for compatibility. Existing model
configuration and readiness response APIs are unchanged.

## TDD Evidence

### RED

The capability TTL regression test failed before implementation:

```text
FAIL uses the configured capability TTL when resolving pool eligibility
AssertionError: expected true to be false
```

The readiness tests also failed before implementation:

```text
TypeError: getModelReadinessChecks is not a function
AssertionError: expected 200 to be 503
```

These failures demonstrated the fixed 24-hour eligibility window and the old
purpose-first `/api/ready` behavior.

### GREEN

Targeted server verification:

```text
npx vitest run src/server/services/model-provider-service.test.ts \
  src/server/services/model-config-service.test.ts \
  src/server/services/model-capabilities.test.ts \
  src/server/services/model-pool-service.test.ts \
  src/server/routes/model-pool-router.test.ts \
  --pool=threads --maxWorkers=1

Test Files  5 passed (5)
Tests       70 passed (70)
```

TypeScript verification:

```text
npm run typecheck
tsc --noEmit: passed
```

Full regression suite:

```text
npm test
Test Files  72 passed (72)
Tests       537 passed (537)
```

## Changed Files

- `src/server/services/model-provider-service.ts`
- `src/server/services/model-provider-service.test.ts`
- `src/server/services/model-config-service.ts`
- `src/server/services/model-config-service.test.ts`
- `src/server/app.ts`
- `task-10-fix-readiness-report.md`
