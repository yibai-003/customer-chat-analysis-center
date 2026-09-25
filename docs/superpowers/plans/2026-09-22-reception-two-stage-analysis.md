# Reception Two-Stage Analysis Implementation Plan

**Goal:** Make reception analysis use one strict vision fact extraction followed by one version-bound quality judgment, with all authoritative scoring derived locally.

## Tasks

- [x] Add a strict reception screenshot-facts execution type and derive reliable session time and completed dialogue rounds locally.
- [x] Replace legacy-compatible quality parsing with a strict schema containing issue IDs, dialogue quotes, evidence explanations, and reasons.
- [x] Build quality prompts from the task-bound field prompt, issue catalog, and knowledge snapshot.
- [x] Derive dimensions, deductions, D-level override, total deduction, grade, suggestions, and review status only from version rules.
- [x] Publish migration 23 with the strict two-stage field configuration while retaining historical versions.
- [x] Cover unknown IDs, schema violations, one vision call, retry reuse, time/round rules, no-issue output, evidence insufficiency, score sums, D override, and boundaries.
- [x] Run type checking, focused tests, migration checks, full tests, lint, build, and diff checks.
