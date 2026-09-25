# Isolated LAN Test and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate local testing, LAN HTTP testing, and the production HTTPS entry, and document repeatable start/stop operations.

**Architecture:** Keep the production app and HTTPS proxy isolated from a separately named LAN test Compose project. The test proxy listens on HTTP port 8444 and forwards only to the test app; test data, knowledge, image tag, host name, and cookie policy are separate. Remove the production HTTP redirect host mapping on port 8080 while preserving HTTPS 8443.

**Tech Stack:** Docker Compose, nginx, PowerShell, Markdown, Vitest.

**Spec:** Approved conversation design on 2026-09-25.

## Global Constraints

- Do not read or modify `deploy/.env`, production databases, production business files, or secrets.
- Do not expose the app container directly to the LAN.
- Keep production on HTTPS port 8443 and route test HTTP only through the isolated test proxy on port 8444.
- Use a distinct test hostname to avoid browser cookie collisions across ports.
- Keep the LAN test stack stopped after configuration; do not copy production data.
- Remove only unreferenced dangling Docker images; preserve tagged images, containers, volumes, and build cache.
- Do not commit or push.

---

### Task 1: Specify the LAN test contract

**Files:**
- Modify: `scripts/local-lan-https-policy.test.mjs`
- Test: `scripts/local-lan-https-policy.test.mjs`

- [x] Assert the production proxy publishes HTTPS only and the setup script no longer exposes/configures an HTTP port.
- [x] Assert the LAN test Compose stack uses a distinct test container, loopback app port, LAN HTTP port 8444, isolated data paths, and `restart: "no"`.
- [x] Run the focused test and confirm it fails against the current configuration.

### Task 2: Add isolated LAN test configuration

**Files:**
- Create: `deploy/docker-compose.lan-test.yml`
- Create: `deploy/nginx-lan-test.conf`
- Create: `deploy/.env.test.example`
- Modify: `.gitignore`
- Modify: `deploy/docker-compose.lan-https.yml`
- Modify: `deploy/.env.example`
- Modify: `deploy/nginx-lan.conf.example`
- Modify: `scripts/setup-local-lan-https.ps1`

- [x] Add a distinct test app/proxy Compose project using HTTP 8444, app loopback port 8789, separate test data paths, and no automatic restart.
- [x] Remove the production proxy's host mapping for HTTP 8080 while retaining its HTTPS 8443 mapping.
- [x] Remove obsolete HTTP-port setup and firewall creation; rerunning the setup script replaces old project firewall rules with the HTTPS-only rule.
- [x] Ignore local test environment and data files without ignoring the tracked environment template or test proxy config.
- [x] Run the focused policy test and Compose rendering checks for both production and test configurations.

### Task 3: Document operating procedures

**Files:**
- Create: `docs/guides/project-operations.md`
- Modify: `docs/README.md`
- Modify: `docs/guides/lan-deployment.md`
- Modify: `docs/guides/lan-client-access.md`

- [x] Document local start, LAN test first-time setup/start/stop, production start, release versus start, firewall/DNS setup, data isolation, and HTTP limitations.
- [x] Update the deployment and client guides to describe the 8443 production entry and remove 8080 as a supported LAN entry.
- [x] Add the operations guide to the documentation index.

### Task 4: Record work item and verify

**Files:**
- Create: `.scratch/lan-test-environment/issue-draft.md`

- [x] Record an Issue draft because GitHub CLI is not authenticated.
- [x] Run focused tests, the full test suite, typecheck, lint, build, smoke, and installation checks.
- [x] Recreate only the existing production proxy, then verify its HTTPS port remains published and 8080 is no longer published.
- [x] Run `docker image prune` without `-a`; compare before/after image inventory and Docker disk usage.
- [x] Confirm the LAN test stack was not started and the worktree contains no secret or runtime data files.
