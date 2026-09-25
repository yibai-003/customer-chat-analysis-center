# Project Work Agreement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-specific work agreement that makes GitHub Issues the status source, routes requests to the right Agent skills, and aligns the existing documentation with that process.

**Architecture:** Add one active project-level agreement under `docs/`, expose it from `docs/README.md`, and update the existing structure guideline only where its ticket-entry wording would otherwise conflict. Existing `.scratch` materials remain in place.

**Tech Stack:** Markdown documentation, GitHub Issues, existing npm verification scripts.

**Spec:** The approved design in the conversation, based on the attached reference work agreement and this repository's existing project structure guidelines.

## Global Constraints

- Do not copy the other project's Effect, pnpm, WSL, Agent-model, or UI-specific rules.
- Do not move or revert existing `.scratch` materials.
- Keep GitHub Issue status authoritative; local documents hold specifications and evidence.
- Do not modify the user's existing code changes.

---

### Task 1: Add the project work agreement

**Files:**
- Create: `docs/project-work-agreement.md`

- [x] Define intake rules for features, bugs, review findings, test failures, release blockers, and temporary experiments.
- [x] Define when the Agent should search for, create, or draft a GitHub Issue.
- [x] Map project work situations to the available skills, including `grill-with-docs`.
- [x] Define the workflow, Issue fields, global numbering, states, priorities, dependencies, and closure criteria.
- [x] Document the existing `.scratch` migration boundary and current project verification commands.

### Task 2: Link the agreement from the documentation index

**Files:**
- Modify: `docs/README.md`

- [x] Add the project work agreement to the developer entry list.

### Task 3: Align the existing structure guideline

**Files:**
- Modify: `docs/project-structure-and-development-guidelines.md`

- [x] Clarify that current `.scratch` tickets are retained as existing release-line material.
- [x] State that new Issue status and numbering are governed by GitHub Issues.
- [x] Link the new work agreement.

### Task 4: Verify the documentation change

**Files:**
- Verify: `docs/project-work-agreement.md`
- Verify: `docs/README.md`
- Verify: `docs/project-structure-and-development-guidelines.md`

- [x] Check Markdown references and required headings.
- [x] Run `git diff --check`.
- [x] Confirm only the intended documentation files were changed by this task.
