# Customer Chat Analysis Center Agent Rules

You are working in Customer Chat Analysis Center. This is a React, Express, TypeScript, SQLite, and Vite application for importing chat-screenshot workbooks, calling vision models, matching knowledge bases, supporting human review, and exporting analysis results.

This file defines how an Agent must behave in this repository. The project workflow is defined in [Project Work Agreement](docs/project-work-agreement.md). Directory, architecture, and database boundaries are defined in [Project Structure and Development Guidelines](docs/project-structure-and-development-guidelines.md).

## 1. Read Before Working

Read the smallest sufficient set of context:

1. This file.
2. `docs/project-work-agreement.md`.
3. `docs/project-structure-and-development-guidelines.md`.
4. `README.md` and `docs/README.md`.
5. The current Issue, relevant specification, ADR, guide, and nearby tests.

Read the relevant domain documentation when the task touches:

- Reception XLSX behavior: `docs/guides/reception-xlsx-release-gate.md`.
- Imports, images, or XLSX resources: `docs/guides/large-file-processing-flow.md`, `docs/guides/xlsx-resource-validation.md`, and `docs/guides/upload-safety.md`.
- Database or migrations: `docs/guides/database-migrations-and-recovery.md`.
- Backups, recovery, or encryption keys: `docs/guides/backup-and-recovery.md` and `docs/guides/encryption-key-management.md`.
- Cancellation, pausing, or model budgets: `docs/guides/cancellation-and-model-budget.md`.
- Architecture decisions: the relevant files under `docs/adr/`.

Do not assume that a reference document applies to this codebase. Use the current code, tests, active guides, and ADRs together to establish the project context.

## 2. Interpret User Intent

- When the user is asking a question, discussing a design, asking why something works, or comparing options, answer without modifying files.
- Enter implementation only when the user explicitly asks to add, fix, refactor, verify, or generate something.
- Do not commit, push, merge, delete, reset, or create a pull request unless the user requests it.
- When the user asks to inspect or check something, perform a read-only inspection and report the result. Do not silently expand the task into implementation.
- When the user says to discuss only, do not change code or create an Issue.
- Before editing, state which files will change, why they need to change, and how the result will be verified.

## 3. Work Items and Skill Routing

Follow `docs/project-work-agreement.md`:

- Questions, progress reports, and design discussions do not normally create Issues.
- New features, complex fixes, cross-module changes, test failures, review findings, and release blockers should use an existing or new GitHub Issue.
- If GitHub access is unavailable, create an Issue draft and clearly state that it was not written to GitHub.
- GitHub's native Issue number is the project's global work-item number. Do not restart numbering inside feature folders.

Choose the workflow or skill that matches the task:

| Task | Default workflow or skill |
| --- | --- |
| Unclear requirements, conflicting terminology, or unclear scope | `grill-with-docs` |
| Domain terminology, module ownership, or architecture boundaries | `domain-modeling`, `codebase-design` |
| New behavior or a behavioral fix | `brainstorming`, followed by `test-driven-development` before implementation |
| Multi-step or cross-module work | `writing-plans` |
| Bugs, failing tests, or performance regressions | `diagnosing-bugs` or `systematic-debugging` |
| Completed implementation review | `code-review` |
| Before claiming completion, committing, or opening a PR | `verification-before-completion` |

Skills are provided by the Agent environment. The repository documents when to use them but does not copy their implementations. If a required skill is unavailable, explain the limitation and follow an equivalent manual process. Never claim to have used a skill that was unavailable.

## 4. Task Size and Collaboration

Handle a task directly in the current session only when all of the following are true:

- It touches one or two files.
- It changes roughly 50 lines or fewer.
- It does not involve a database migration, public contract, authorization, security boundary, import/export contract, or release process.
- It does not require the full test suite, a build, or a long-running environment check.

When any condition is not met, establish the Issue, specification, or implementation plan before deciding whether to delegate. Parallel work must declare file and directory ownership in advance so Agents do not edit the same files.

Every delegated task must state:

- The Issue, specification, and relevant ADR.
- The background, goal, and out-of-scope behavior.
- The files or directories the Agent may modify.
- The acceptance criteria and verification commands.
- Whether commits are allowed.

An Agent report never replaces the main session's code inspection and verification.

## 5. Code Boundaries

Keep dependencies moving in these directions:

```text
client -> server API
route -> service -> repository / AI / security
shared -> stable contracts used by both client and server
```

### Frontend

- `src/client/App.tsx` composes pages, dialogs, and top-level state. It must not absorb complete business rules.
- Components render UI and collect input. HTTP transport belongs in the API layer. Async workflows and polling belong in hooks.
- Put new features in a focused feature directory instead of continuing to grow the root of `components/`.
- Preserve existing styles, interactions, permissions, loading states, empty states, error states, and narrow-screen behavior.
- Reuse existing components and icon patterns instead of creating near-duplicates.

### Server

- Routes handle input, capability checks, status codes, and response formatting.
- Business rules belong in services, not in routes or duplicated frontend code.
- Database access goes through repositories or explicit persistence boundaries.
- Services must not depend on Express `Request` or `Response`.
- `src/server/app.ts` is for middleware and route composition.
- Centralize input validation, upload safety, disk limits, and authorization boundaries instead of rebuilding them per route.

### Shared Contracts and Types

- `src/shared` contains stable types, enums, schemas, and pure functions needed by both client and server.
- Split growing shared types by domain instead of appending every new contract to one large file.
- Avoid `any`. Prefer inferred types, explicit unions, schemas, and type guards.
- Do not create boundaryless catch-all modules just to shorten import paths.

## 6. Database, Files, and Security

- Published migrations are append-only. New schema changes require a new ordered migration, migration-lock updates, and migration tests.
- Migrations must consider old data, failure rollback, and repeated execution.
- The LAN SQLite deployment is single-instance and uses local host storage, never a network share.
- Do not directly operate on production databases, daily-use databases, or real business files unless the user explicitly authorizes the exact target.
- Never read, print, or commit `.env` files, API keys, passwords, cookies, databases, backups, logs, real chat screenshots, or real business workbooks.
- Use ignored sample and artifact directories for real XLSX release validation. Never commit real samples.
- When changing upload, extraction, image, export, or backup logic, check size limits, disk reservations, path traversal, resource cleanup, and failure cleanup.
- Never use `git reset --hard`, `git checkout -- <file>`, or another command that can discard user changes.
- Do not use `git stash` to hide current work unless the user explicitly requests it and the impact on all worktrees is understood.

Run `git status` before starting. Preserve existing user changes. If they affect the current task, explain the interaction and work with them rather than reverting them.

## 7. TypeScript and Implementation Style

- Follow the existing TypeScript, React, and Express patterns. Do not introduce a new framework or state library because of personal preference.
- Use parsers, schemas, and structured APIs for structured data. Do not replace reliable parsing with fragile string manipulation.
- Add an abstraction only when it reduces real complexity or matches an existing boundary.
- Keep functions and modules focused. When a file becomes large, identify responsibility boundaries instead of creating thin wrappers only to reduce line count.
- Comments should explain usage, business reasons, or non-obvious constraints. Do not comment every line.
- Keep comments, tests, documentation, and error messages synchronized with behavior changes.
- Default to ASCII in new code and documentation unless the existing file or user-facing content requires another character set.

## 8. Testing and Verification

For new features and bug fixes, write a test that expresses the behavior or reproduces the failure before writing the minimal implementation. Tests should focus on user behavior, domain rules, boundaries, and regression risk. Do not add meaningless tests for deleted or nonexistent behavior.

Run the commands required by the change:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npm run db:check
npm run smoke
npm run check:installation
```

For reception XLSX changes, also run:

```powershell
npm run test:reception-xlsx
npm run gate:reception-xlsx
```

For LAN, container, backup, recovery, or real-runtime work, run the relevant verification scripts under `scripts/`.

Verification rules:

- Run the most relevant focused tests first, then expand verification according to risk.
- Do not manufacture a passing result when the environment lacks a database, real sample, or manual acceptance condition.
- When a command fails, record its exit code, important output, actual cause, and whether it is an environment blocker.
- Before claiming that work is complete, fixed, or passing, rerun the command that proves that claim.
- Local success does not replace GitHub Actions, real Excel/WPS inspection, or release-ticket requirements.

## 9. Git, Commits, and Pull Requests

- Do not commit, push, merge, or open a pull request unless the user explicitly requests it.
- When committing, keep one commit focused on one purpose and follow the repository's existing Conventional Commit style.
- Do not use `git add -A`; stage only the intended files and exclude data or temporary output.
- Pull requests must link to the GitHub Issue and explain the problem, the solution, the verification commands, and known limitations.
- For migrations, releases, real samples, or manual acceptance, list the relevant evidence in the pull request.
- Verify review findings against the source and specification before changing code. Do not act only on a tool or Agent report.
- Do not make business assertions weaker, delete meaningful tests, or change expected values merely to obtain a green test run.

## 10. Completion Report

Keep the final report concise and state:

1. Which files changed and what problem was addressed.
2. The related GitHub Issue, specification, or pull request.
3. Which verification commands actually ran and their results.
4. Any incomplete manual acceptance, environment blocker, or residual risk.
5. Whether uncommitted changes remain and which of them predated the task.
