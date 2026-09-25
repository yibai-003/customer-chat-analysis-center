# [Release] Separate LAN test runtime from production

> Status: Draft only; not written to GitHub because GitHub CLI is not authenticated.

## Goal

Provide distinct local-test, LAN-test, and production entry points with isolated test data and simple daily start/stop commands.

## Background and scope

The current production HTTPS entry is `https://chat.customer.lan:8443`. Port `8080` only redirects to production and is confusing as an apparent test entry. Add an isolated HTTP LAN test stack on port `8444` with a distinct hostname, app container, image tag, data directory, knowledge directory, and model configuration. Keep the local runtime at `http://localhost:8787`.

## Out of scope

- Copying production data, credentials, encryption keys, or knowledge files into test.
- Changing application authentication or authorization behavior.
- Starting the LAN test stack automatically.
- Deleting tagged rollback images, containers, volumes, or Docker build cache.
- Committing or pushing changes.

## Acceptance criteria

- [x] Production continues to publish HTTPS on 8443 and no longer publishes host port 8080.
- [x] LAN test uses HTTP 8444 through a proxy and does not publish the app directly to the LAN.
- [x] Test hostname and storage are distinct from production; the test stack does not auto-start.
- [x] The operations guide documents start, stop, release, first-run, DNS, firewall, and HTTP limitations.
- [x] Only unreferenced dangling images are pruned.

## Verification commands

- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run smoke`
- `npm run check:installation`
- `docker compose ... config --quiet` for production and LAN test Compose files.

## Local verification result

- Focused LAN policy test: 3 tests passed.
- Production and LAN test Compose configuration rendering: passed.
- PowerShell syntax parsing: passed.
- `git diff --check`: passed.
- Full test, typecheck, lint, build, smoke, and installation checks: run before commit.

## Commit

Pending user-authorized push from `feat/lan-test-environment`.
