# Reception Config V9 Reconciliation Implementation Plan

> **For agentic workers:** Execute inline in this session, task by task. Preserve the current workspace commits and never inspect or print production databases, backups, logs, secrets, or business files.

**Goal:** Bring the LAN instance whose reception configuration history stops at V7 to the tested V9 current snapshot without changing prior versions or task history.

**Architecture:** Add an idempotent startup data reconciliation that handles only the known V7 reception-version state by adding V8 issue-row and V9 screenshot-row snapshots based on the current snapshot. Keep `schema_migrations` at 29 so rollback to the previous image remains supported. Test the actual startup path, then deploy through the LAN release script after a verified full backup.

**Tech Stack:** TypeScript, SQLite migrations, Vitest, Docker Compose, PowerShell.

**Spec:** `.scratch/lan-release-closure/issues/05-reception-config-v9-migration-gap.md`

## Global Constraints

- Do not edit or replay migrations 002–029.
- Keep database writes inside one SQLite transaction and preserve existing snapshots and task references.
- Use only the approved LAN target at `https://chat.customer.lan:8443`.
- Never read or print `.env`, databases, backups, logs, encryption keys, or real business files.
- Do not push, merge, or create a pull request.

---

### Task 1: Reproduce and repair the version gap without a schema bump

**Files:**
- Create: `src/server/db/reconcile-reception-v9.ts`
- Modify: `src/server/db/client.ts`
- Test: `src/server/db/migrations/migrations.test.ts`

**Interfaces:**
- Startup repair exports `reconcileReceptionV9(db: any): void`.
- Schema migration registry and migration lock remain unchanged at version 29.

- [x] Add a startup-path regression test simulating schema migrations 28 and 29 already recorded while reception history remains at V7; assert V9 is current, V8/V9 contain expected export row modes, and schema version remains 29.
- [x] Run the focused migration test and confirm it fails because current remains V7.
- [x] Implement the startup repair to preserve current snapshots and create the missing V8/V9 immutable versions with migration audit events; no-op when V9 already exists.
- [x] Hook the repair after schema migrations and before seed initialization.
- [x] Re-run the focused migration test and the full migration test file.

### Task 2: Validate and deploy the approved LAN target

**Files:**
- No further source changes unless verification finds a defect.

- [x] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`, and `npm run check:installation`.
- [x] Create a full backup using the running target container and confirm the backup command succeeds; leave the existing managed key untouched.
- [ ] Commit only the Issue draft, plan, startup repair, client hook, and migration test files.
- [ ] Run `scripts/lan-deploy.ps1` for container `lan-preview` and entry `http://127.0.0.1:8788`; require health, readiness, version, and assets checks to pass.
- [ ] Confirm `/api/version` reports the deployed commit and the authenticated configuration-version UI reports V9 as current.
- [ ] Report exact verification results, backup/deployment evidence, and any remaining limitations.

`npm run db:check` is intentionally not run against the workstation's default database path; the deployment's container `ready:check` validates the approved target database.

GitHub CLI is unauthenticated, so the Issue remains a local draft and has not been written to GitHub.
