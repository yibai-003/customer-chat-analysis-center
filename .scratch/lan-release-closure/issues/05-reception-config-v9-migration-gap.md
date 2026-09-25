# [Bug] Reconcile reception configuration history to V9

## Goal

Ensure an installation whose reception configuration history stopped at V7 reaches the tested V9 current snapshot during startup, without changing its schema version.

## Background and scope

The approved LAN entry is running commit `e537b5706c54971129dcedd4e4c6ffb31a126537` and reports schema migration 29, while the configuration-version UI lists only V1–V7. Existing schema migrations through 29 can leave this history at V7, despite the expected V9 configuration. Reconcile only this exact state at startup by creating V8 issue-row and V9 screenshot-row snapshots from the active configuration, preserving existing history and task references. Keep schema version 29 so the prior application image remains rollback-compatible.

## Not in scope

- Rebuilding or rewriting V1–V7.
- Editing migrations 002–029.
- Changing task results, imported files, knowledge data, credentials, or model configuration.
- Pushing commits, merging branches, or opening a pull request.

## Blocked by

- GitHub CLI is not authenticated; this is a local Issue draft and has not been written to GitHub.

## Acceptance conditions

- [x] Startup reconciliation upgrades the known V7 state to V9 current without changing schema migrations or existing snapshots.
- [x] V8 uses `reception_issue_records`; V9 uses `screenshot_records`.
- [x] Repeated startup at V9 does not create duplicate versions.
- [ ] Migration tests, required code checks, target backup, deployment checks, and the live UI version check pass.

## Verification commands

```powershell
npm test -- src/server/db/migrations/migrations.test.ts
npm test
npm run typecheck
npm run lint
npm run build
npm run db:check
npm run smoke
npm run check:installation
```

`npm run db:check` was not run against the workstation's default database path to avoid opening an unconfirmed daily-use database. The approved LAN deployment runs the container's `ready:check` against its mounted database.

LAN release verification uses `scripts/lan-deploy.ps1` with the approved `lan-preview` container and `http://127.0.0.1:8788` entry. The HTTPS configuration-version UI must show V9 as current after deployment.

## Related files and deployment target

- `src/server/db/migrations/migrations.test.ts`
- `docs/guides/lan-deployment.md`
- `docs/guides/lan-operations.md`
- `https://chat.customer.lan:8443`
