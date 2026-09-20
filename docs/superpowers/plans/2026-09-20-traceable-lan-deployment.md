# Traceable LAN Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested deployment path that binds a Git commit to a Docker image, running container, runtime version response, and browser assets, with automatic rollback on failed verification.

**Architecture:** The server exposes immutable build metadata through a public `/api/version` endpoint and shares one readiness service between the authenticated `/api/ready` route and a container-local CLI. A pure JavaScript deployment policy module owns tag generation and verification decisions; PowerShell orchestrates Git, quality gates, Docker Compose, health checks, version checks, and rollback without modifying persistent data.

**Tech Stack:** TypeScript 7, Express 5, Vitest 4, Node.js 22+, PowerShell 7/Windows PowerShell, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-20-traceable-lan-deployment-design.md`

## Global Constraints

- Do not expose credentials, database paths, model configuration, or host paths from `/api/version`.
- Keep `/api/ready` administrator-protected.
- The deployment script must not persist an administrator password, session cookie, or deployment token.
- Reuse `DEPLOY_DATA_DIR` and `DEPLOY_KNOWLEDGE_DIR`; never delete or recreate persistent directories during deploy or rollback.
- A failed health, readiness, version, or asset check must return a nonzero exit code and attempt rollback when a previous container exists.
- Real host deployment, screenshots, and the deploy/rollback/redeploy drill remain acceptance work.

---

### Task 1: Runtime Version Metadata and Public Route

**Files:**
- Create: `src/server/runtime-version.ts`
- Create: `src/server/runtime-version.test.ts`
- Create: `src/server/version-route.test.ts`
- Modify: `src/server/app.ts`

**Interfaces:**
- Produces: `RuntimeVersion`
- Produces: `readRuntimeVersion(options?: RuntimeVersionOptions): RuntimeVersion`
- Extends: `AppDependencies.runtimeVersionProvider?: () => RuntimeVersion`
- Adds: `GET /api/version`

- [ ] **Step 1: Write failing unit tests for metadata and asset extraction**

Create `src/server/runtime-version.test.ts` with temporary `dist/index.html` fixtures:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRuntimeVersion } from "./runtime-version";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("runtime version", () => {
  it("returns injected build metadata and normalized entry assets", () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-version-"));
    roots.push(distDir);
    fs.writeFileSync(path.join(distDir, "index.html"), [
      '<script type="module" src="/assets/index-abc.js"></script>',
      '<link rel="stylesheet" href="/assets/index-def.css">',
    ].join(""));

    expect(readRuntimeVersion({
      distDir,
      env: {
        APP_VERSION: "0.1.0",
        APP_COMMIT_SHA: "a".repeat(40),
        APP_BUILD_TIME: "2026-09-20T08:00:00.000Z",
        APP_IMAGE: "customer-chat-analysis-center:0.1.0-aaaaaaaaaaaa",
      },
    })).toEqual({
      version: "0.1.0",
      commitSha: "a".repeat(40),
      buildTime: "2026-09-20T08:00:00.000Z",
      image: "customer-chat-analysis-center:0.1.0-aaaaaaaaaaaa",
      assets: {
        scripts: ["assets/index-abc.js"],
        styles: ["assets/index-def.css"],
      },
    });
  });

  it("uses explicit development defaults without reading Git metadata", () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-version-"));
    roots.push(distDir);
    expect(readRuntimeVersion({ distDir, env: {} })).toMatchObject({
      version: "0.1.0",
      commitSha: "development",
      buildTime: "development",
      image: "development",
      assets: { scripts: [], styles: [] },
    });
  });
});
```

- [ ] **Step 2: Run the metadata test and verify RED**

Run:

```powershell
npx vitest run src/server/runtime-version.test.ts
```

Expected: FAIL because `./runtime-version` does not exist.

- [ ] **Step 3: Implement the metadata reader**

Create `src/server/runtime-version.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { projectRoot } from "./environment";

export interface RuntimeVersion {
  version: string;
  commitSha: string;
  buildTime: string;
  image: string;
  assets: { scripts: string[]; styles: string[] };
}

export interface RuntimeVersionOptions {
  distDir?: string;
  env?: NodeJS.ProcessEnv;
}

function entryAssets(html: string) {
  const scripts = [...html.matchAll(/<script[^>]+src=["']\/?([^"']+\.js)["']/g)]
    .map((match) => match[1]);
  const styles = [...html.matchAll(/<link[^>]+href=["']\/?([^"']+\.css)["']/g)]
    .map((match) => match[1]);
  return { scripts: [...new Set(scripts)], styles: [...new Set(styles)] };
}

export function readRuntimeVersion(options: RuntimeVersionOptions = {}): RuntimeVersion {
  const env = options.env ?? process.env;
  const distDir = options.distDir ?? path.join(projectRoot, "dist");
  const indexPath = path.join(distDir, "index.html");
  const html = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "";
  return {
    version: env.APP_VERSION || packageJson.version,
    commitSha: env.APP_COMMIT_SHA || "development",
    buildTime: env.APP_BUILD_TIME || "development",
    image: env.APP_IMAGE || "development",
    assets: entryAssets(html),
  };
}
```

- [ ] **Step 4: Run the metadata test and verify GREEN**

Run:

```powershell
npx vitest run src/server/runtime-version.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 5: Write a failing HTTP route test**

Create `src/server/version-route.test.ts` using a real ephemeral HTTP listener:

```ts
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = undefined;
});

describe("GET /api/version", () => {
  it("is available without authentication and exposes only release metadata", async () => {
    const app = createApp({
      runtimeVersionProvider: () => ({
        version: "0.1.0",
        commitSha: "b".repeat(40),
        buildTime: "2026-09-20T08:00:00.000Z",
        image: "customer-chat-analysis-center:0.1.0-bbbbbbbbbbbb",
        assets: { scripts: ["assets/index-a.js"], styles: ["assets/index-b.css"] },
      }),
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/version`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.commitSha).toBe("b".repeat(40));
    expect(JSON.stringify(body)).not.toMatch(/database|apiKey|dataDir|password/i);
  });
});
```

- [ ] **Step 6: Run the route test and verify RED**

Run:

```powershell
npx vitest run src/server/version-route.test.ts
```

Expected: TypeScript/runtime failure because `runtimeVersionProvider` and `/api/version` are not implemented.

- [ ] **Step 7: Add the dependency and route**

In `src/server/app.ts`:

```ts
import { readRuntimeVersion, type RuntimeVersion } from "./runtime-version";

interface AppDependencies {
  // existing dependencies...
  runtimeVersionProvider?: () => RuntimeVersion;
}
```

Add the route immediately after `/api/health` and before auth middleware:

```ts
app.get("/api/version", (_req, res) => {
  return ok(res, (dependencies.runtimeVersionProvider ?? readRuntimeVersion)());
});
```

- [ ] **Step 8: Run focused tests**

Run:

```powershell
npx vitest run src/server/runtime-version.test.ts src/server/version-route.test.ts
```

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```powershell
git add src/server/runtime-version.ts src/server/runtime-version.test.ts src/server/version-route.test.ts src/server/app.ts
git commit -m "feat: expose traceable runtime version metadata"
```

---

### Task 2: Shared Readiness Service and Container CLI

**Files:**
- Create: `src/server/services/readiness-service.ts`
- Create: `src/server/services/readiness-service.test.ts`
- Create: `src/server/readiness-cli.ts`
- Create: `src/server/readiness-cli.test.ts`
- Modify: `src/server/app.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `ReadinessStatus`
- Produces: `getReadinessStatus(dependencies?: ReadinessDependencies): ReadinessStatus`
- Produces: `runReadinessCli(options?: ReadinessCliOptions): number`
- Extends: `AppDependencies.readinessProvider?: () => ReadinessStatus`
- Adds: `npm run ready:check`

- [ ] **Step 1: Write failing readiness service tests**

Create `src/server/services/readiness-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getReadinessStatus } from "./readiness-service";

const checks = {
  vision: { verified: true },
  text: { verified: true },
};

describe("readiness service", () => {
  it("is ready only when disk and both model purposes are ready", () => {
    expect(getReadinessStatus({
      dataDir: "C:/data",
      minFreeDiskMb: 512,
      statfs: () => ({ bavail: 2048, bsize: 1024 * 1024 }),
      modelChecks: () => checks as never,
      modelActions: () => ({ verifyPoolMemberIds: [] }) as never,
    })).toMatchObject({
      ready: true,
      database: true,
      freeDiskMb: 2048,
      models: { vision: true, text: true },
    });
  });

  it("reports an actionable non-ready result", () => {
    const result = getReadinessStatus({
      dataDir: "C:/data",
      minFreeDiskMb: 512,
      statfs: () => ({ bavail: 100, bsize: 1024 * 1024 }),
      modelChecks: () => ({ ...checks, text: { verified: false } }) as never,
      modelActions: () => ({ verifyPoolMemberIds: ["text-model"] }) as never,
    });
    expect(result.ready).toBe(false);
    expect(result.models).toEqual({ vision: true, text: false });
    expect(result.actions).toEqual({ verifyPoolMemberIds: ["text-model"] });
  });
});
```

- [ ] **Step 2: Run service tests and verify RED**

Run:

```powershell
npx vitest run src/server/services/readiness-service.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the readiness service**

Create `src/server/services/readiness-service.ts` with injected defaults:

```ts
import fs from "node:fs";
import { config } from "../config";
import {
  getModelReadinessActions,
  getModelReadinessChecks,
} from "./model-config-service";

export interface ReadinessDependencies {
  dataDir: string;
  minFreeDiskMb: number;
  statfs: (path: string) => { bavail: number | bigint; bsize: number | bigint };
  modelChecks: typeof getModelReadinessChecks;
  modelActions: typeof getModelReadinessActions;
}

export interface ReadinessStatus {
  ready: boolean;
  database: true;
  freeDiskMb: number;
  minFreeDiskMb: number;
  models: { vision: boolean; text: boolean };
  modelChecks: ReturnType<typeof getModelReadinessChecks>;
  actions: ReturnType<typeof getModelReadinessActions>;
}

const defaults: ReadinessDependencies = {
  dataDir: config.dataDir,
  minFreeDiskMb: config.minFreeDiskMb,
  statfs: fs.statfsSync,
  modelChecks: getModelReadinessChecks,
  modelActions: getModelReadinessActions,
};

export function getReadinessStatus(
  dependencies: ReadinessDependencies = defaults,
): ReadinessStatus {
  const disk = dependencies.statfs(dependencies.dataDir);
  const freeDiskMb = Math.floor(
    Number(disk.bavail) * Number(disk.bsize) / 1024 / 1024,
  );
  const modelChecks = dependencies.modelChecks();
  const models = {
    vision: modelChecks.vision.verified,
    text: modelChecks.text.verified,
  };
  return {
    ready: freeDiskMb >= dependencies.minFreeDiskMb && models.vision && models.text,
    database: true,
    freeDiskMb,
    minFreeDiskMb: dependencies.minFreeDiskMb,
    models,
    modelChecks,
    actions: dependencies.modelActions(),
  };
}
```

- [ ] **Step 4: Replace duplicated `/api/ready` logic**

Extend `AppDependencies`:

```ts
readinessProvider?: () => ReadinessStatus;
```

Replace the route body with:

```ts
app.get("/api/ready", canManageSystem, (_req, res) => {
  try {
    const status = (dependencies.readinessProvider ?? getReadinessStatus)();
    return res.status(status.ready ? 200 : 503).json({
      success: status.ready,
      data: status,
      error: status.ready ? null : "模型未检测、检测失败/过期，或磁盘空间不足",
    });
  } catch (error) {
    return fail(res, error, 503);
  }
});
```

- [ ] **Step 5: Run readiness and existing readiness tests**

Run:

```powershell
npx vitest run src/server/services/readiness-service.test.ts src/server/auth/authorization.test.ts src/server/startup.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Write failing CLI tests**

Create `src/server/readiness-cli.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runReadinessCli } from "./readiness-cli";

describe("readiness CLI", () => {
  it("prints JSON and returns zero for a ready instance", () => {
    const write = vi.fn();
    const status = { ready: true, database: true };
    expect(runReadinessCli({ provider: () => status as never, write })).toBe(0);
    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject(status);
  });

  it("returns one for a non-ready instance", () => {
    expect(runReadinessCli({
      provider: () => ({ ready: false }) as never,
      write: () => undefined,
    })).toBe(1);
  });
});
```

- [ ] **Step 7: Run CLI tests and verify RED**

Run:

```powershell
npx vitest run src/server/readiness-cli.test.ts
```

Expected: FAIL because the CLI module does not exist.

- [ ] **Step 8: Implement the CLI and package script**

Create `src/server/readiness-cli.ts`:

```ts
import { pathToFileURL } from "node:url";
import { getReadinessStatus, type ReadinessStatus } from "./services/readiness-service";

export interface ReadinessCliOptions {
  provider?: () => ReadinessStatus;
  write?: (value: string) => void;
}

export function runReadinessCli(options: ReadinessCliOptions = {}): number {
  const status = (options.provider ?? getReadinessStatus)();
  (options.write ?? console.log)(JSON.stringify(status));
  return status.ready ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runReadinessCli();
}
```

Add to `package.json`:

```json
"ready:check": "tsx src/server/readiness-cli.ts"
```

- [ ] **Step 9: Run focused tests and CLI**

Run:

```powershell
npx vitest run src/server/services/readiness-service.test.ts src/server/readiness-cli.test.ts
npm run ready:check
```

Expected: tests PASS; the CLI prints JSON and exits `0` only when the local configured models and disk are ready.

- [ ] **Step 10: Commit**

```powershell
git add src/server/services/readiness-service.ts src/server/services/readiness-service.test.ts src/server/readiness-cli.ts src/server/readiness-cli.test.ts src/server/app.ts package.json
git commit -m "feat: share readiness checks with deployment CLI"
```

---

### Task 3: Deployment Policy Module

**Files:**
- Create: `scripts/lan-deploy-policy.mjs`
- Create: `scripts/lan-deploy-policy.test.mjs`

**Interfaces:**
- Produces: `createImageTag(input): string`
- Produces: `extractEntryAssets(html): { scripts: string[]; styles: string[] }`
- Produces: `verifyDeployment(input): DeploymentVerification`
- Produces: CLI subcommands `image-tag` and `verify`

- [ ] **Step 1: Write failing policy tests**

Create `scripts/lan-deploy-policy.test.mjs`:

```js
import { describe, expect, it } from "vitest";
import {
  createImageTag,
  extractEntryAssets,
  verifyDeployment,
} from "./lan-deploy-policy.mjs";

describe("LAN deployment policy", () => {
  it("binds the package version to the first twelve commit characters", () => {
    expect(createImageTag({
      repository: "customer-chat-analysis-center",
      version: "0.1.0",
      commitSha: "abcdef1234567890abcdef1234567890abcdef12",
    })).toBe("customer-chat-analysis-center:0.1.0-abcdef123456");
    expect(() => createImageTag({
      repository: "app",
      version: "0.1.0",
      commitSha: "dirty",
    })).toThrow(/commit/i);
  });

  it("extracts normalized entry assets", () => {
    expect(extractEntryAssets(
      '<script src="/assets/index-a.js"></script><link href="/assets/index-b.css" rel="stylesheet">',
    )).toEqual({
      scripts: ["assets/index-a.js"],
      styles: ["assets/index-b.css"],
    });
  });

  it("accepts only a healthy ready matching deployment", () => {
    const base = {
      targetCommitSha: "a".repeat(40),
      targetImage: "app:0.1.0-aaaaaaaaaaaa",
      healthy: true,
      readinessExitCode: 0,
      runtime: {
        commitSha: "a".repeat(40),
        image: "app:0.1.0-aaaaaaaaaaaa",
        assets: { scripts: ["assets/a.js"], styles: ["assets/a.css"] },
      },
      entryAssets: { scripts: ["assets/a.js"], styles: ["assets/a.css"] },
    };
    expect(verifyDeployment(base)).toEqual({ ok: true, reasons: [], rollback: false });
    expect(verifyDeployment({ ...base, healthy: false })).toMatchObject({
      ok: false,
      rollback: true,
      reasons: ["health"],
    });
    expect(verifyDeployment({
      ...base,
      runtime: { ...base.runtime, commitSha: "b".repeat(40) },
    })).toMatchObject({ ok: false, rollback: true, reasons: ["commit"] });
    expect(verifyDeployment({
      ...base,
      entryAssets: { scripts: ["assets/old.js"], styles: ["assets/a.css"] },
    })).toMatchObject({ ok: false, rollback: true, reasons: ["assets"] });
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npx vitest run scripts/lan-deploy-policy.test.mjs
```

Expected: FAIL because the policy module does not exist.

- [ ] **Step 3: Implement the pure policy**

Implement exact normalization and comparison:

```js
const SHA_PATTERN = /^[a-f0-9]{40}$/i;

export function createImageTag({ repository, version, commitSha }) {
  if (!repository?.trim() || !version?.trim() || !SHA_PATTERN.test(commitSha)) {
    throw new Error("repository, version and full commit SHA are required");
  }
  return `${repository}:${version}-${commitSha.slice(0, 12).toLowerCase()}`;
}

export function extractEntryAssets(html) {
  const scripts = [...String(html).matchAll(/<script[^>]+src=["']\/?([^"']+\.js)["']/g)]
    .map((match) => match[1]);
  const styles = [...String(html).matchAll(/<link[^>]+href=["']\/?([^"']+\.css)["']/g)]
    .map((match) => match[1]);
  return { scripts: [...new Set(scripts)], styles: [...new Set(styles)] };
}

function sameAssets(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function verifyDeployment(input) {
  const reasons = [];
  if (!input.healthy) reasons.push("health");
  if (input.readinessExitCode !== 0) reasons.push("readiness");
  if (input.runtime?.commitSha !== input.targetCommitSha) reasons.push("commit");
  if (input.runtime?.image !== input.targetImage) reasons.push("image");
  if (!sameAssets(input.runtime?.assets?.scripts ?? [], input.entryAssets?.scripts ?? [])
    || !sameAssets(input.runtime?.assets?.styles ?? [], input.entryAssets?.styles ?? [])) {
    reasons.push("assets");
  }
  return { ok: reasons.length === 0, reasons, rollback: reasons.length > 0 };
}
```

Add a direct-execution CLI that:

- prints an image tag for `image-tag <repository> <version> <sha>`;
- reads verification JSON from stdin for `verify`;
- prints JSON and exits `0` for success, `1` for failed verification, `2` for invalid arguments.

- [ ] **Step 4: Run policy tests and CLI probes**

Run:

```powershell
npx vitest run scripts/lan-deploy-policy.test.mjs
node scripts/lan-deploy-policy.mjs image-tag customer-chat-analysis-center 0.1.0 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

Expected: tests PASS; CLI prints `customer-chat-analysis-center:0.1.0-aaaaaaaaaaaa`.

- [ ] **Step 5: Commit**

```powershell
git add scripts/lan-deploy-policy.mjs scripts/lan-deploy-policy.test.mjs
git commit -m "test: define LAN deployment verification policy"
```

---

### Task 4: Docker Metadata, Compose Wiring, and Deployment Script

**Files:**
- Modify: `Dockerfile`
- Modify: `deploy/docker-compose.yml`
- Modify: `deploy/.env.example`
- Create: `scripts/lan-deploy.ps1`
- Modify: `scripts/verify-lan-runtime.ps1`

**Interfaces:**
- Adds build args/environment: `APP_VERSION`, `APP_COMMIT_SHA`, `APP_BUILD_TIME`, `APP_IMAGE`
- Adds Compose variable: `APP_CONTAINER_NAME`
- Adds command: `pwsh -File scripts/lan-deploy.ps1`
- Supports rollback: `pwsh -File scripts/lan-deploy.ps1 -RollbackImage <tag>`

- [ ] **Step 1: Add a failing static contract test**

Extend `scripts/lan-deploy-policy.test.mjs` to read repository files and assert:

```js
import fs from "node:fs";

it("wires build metadata and the deployment entry point", () => {
  const dockerfile = fs.readFileSync("Dockerfile", "utf8");
  const compose = fs.readFileSync("deploy/docker-compose.yml", "utf8");
  const script = fs.readFileSync("scripts/lan-deploy.ps1", "utf8");
  expect(dockerfile).toContain("ARG APP_COMMIT_SHA");
  expect(dockerfile).toContain("ENV APP_COMMIT_SHA=");
  expect(compose).toContain("APP_CONTAINER_NAME");
  expect(compose).toContain("APP_COMMIT_SHA");
  expect(script).toContain("npm run ready:check");
  expect(script).toContain("lan-deploy-policy.mjs");
  expect(script).toContain("RollbackImage");
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```powershell
npx vitest run scripts/lan-deploy-policy.test.mjs
```

Expected: FAIL because metadata wiring and `lan-deploy.ps1` do not exist.

- [ ] **Step 3: Add Docker build metadata**

In the runtime stage of `Dockerfile`:

```dockerfile
ARG APP_VERSION=0.1.0
ARG APP_COMMIT_SHA=development
ARG APP_BUILD_TIME=development
ARG APP_IMAGE=development
ENV APP_VERSION=${APP_VERSION} \
    APP_COMMIT_SHA=${APP_COMMIT_SHA} \
    APP_BUILD_TIME=${APP_BUILD_TIME} \
    APP_IMAGE=${APP_IMAGE}
```

Keep existing production environment values in the same `ENV` declaration or a following declaration.

- [ ] **Step 4: Wire Compose variables**

Update `deploy/docker-compose.yml`:

```yaml
services:
  app:
    image: ${APP_IMAGE:-customer-chat-analysis:lan}
    build:
      context: ..
      dockerfile: Dockerfile
      args:
        APP_VERSION: ${APP_VERSION:-0.1.0}
        APP_COMMIT_SHA: ${APP_COMMIT_SHA:-development}
        APP_BUILD_TIME: ${APP_BUILD_TIME:-development}
        APP_IMAGE: ${APP_IMAGE:-customer-chat-analysis:lan}
    container_name: ${APP_CONTAINER_NAME:-customer-chat-analysis}
    environment:
      APP_VERSION: ${APP_VERSION:-0.1.0}
      APP_COMMIT_SHA: ${APP_COMMIT_SHA:-development}
      APP_BUILD_TIME: ${APP_BUILD_TIME:-development}
      APP_IMAGE: ${APP_IMAGE:-customer-chat-analysis:lan}
```

Add matching commented values to `deploy/.env.example`.

- [ ] **Step 5: Implement `scripts/lan-deploy.ps1`**

Use this public parameter contract:

```powershell
param(
  [string]$EnvFile = "deploy/.env",
  [string]$ImageRepository = "customer-chat-analysis-center",
  [string]$ContainerName = "customer-chat-analysis",
  [string]$EntryUrl = "http://127.0.0.1:8787",
  [string]$RollbackImage = "",
  [switch]$Preview,
  [switch]$SkipQualityGates
)
```

Implement focused helpers:

```powershell
function Invoke-Checked([string]$Label, [scriptblock]$Command)
function Wait-ContainerHealthy([string]$Name, [int]$Attempts = 40)
function Get-ContainerImage([string]$Name)
function Get-RuntimeVersion([string]$BaseUrl)
function Get-EntryAssets([string]$BaseUrl)
function Invoke-ComposeImage([string]$Image)
function Restore-PreviousImage([string]$Image)
```

Required command sequence:

```powershell
$commit = (git rev-parse HEAD).Trim()
$status = git status --porcelain
if (-not $Preview -and $status) { throw "正式部署要求干净工作区" }
$version = node -p "require('./package.json').version"
$targetImage = node scripts/lan-deploy-policy.mjs image-tag $ImageRepository $version $commit
$buildTime = [DateTimeOffset]::UtcNow.ToString("o")
```

Unless `-SkipQualityGates` is explicitly set, run:

```powershell
npm run check:installation
npm test
npm run typecheck
npm run lint
npm run build
```

Before replacement, capture:

```powershell
$previousImage = Get-ContainerImage $ContainerName
$previousVersion = if ($previousImage) { Get-RuntimeVersion $EntryUrl } else { $null }
```

Build with:

```powershell
docker build `
  --build-arg "APP_VERSION=$version" `
  --build-arg "APP_COMMIT_SHA=$commit" `
  --build-arg "APP_BUILD_TIME=$buildTime" `
  --build-arg "APP_IMAGE=$targetImage" `
  -t $targetImage .
```

Set process-scoped Compose variables and deploy:

```powershell
$env:APP_IMAGE = $targetImage
$env:APP_VERSION = $version
$env:APP_COMMIT_SHA = $commit
$env:APP_BUILD_TIME = $buildTime
$env:APP_CONTAINER_NAME = $ContainerName
docker compose --env-file $EnvFile -f deploy/docker-compose.yml up -d --no-build app
```

Verify in this order:

1. `Wait-ContainerHealthy`.
2. `docker exec $ContainerName npm run ready:check`.
3. `GET $EntryUrl/api/version`.
4. `GET $EntryUrl/` and extract assets.
5. Pipe JSON into `node scripts/lan-deploy-policy.mjs verify`.

On verification failure, call `Restore-PreviousImage $previousImage`, wait for health, and verify that the restored runtime image equals the captured previous image. Never remove the target image or persistent directories.

When `-RollbackImage` is provided, skip build and quality gates, set `APP_IMAGE` to that exact value, run Compose, then perform health, readiness, version, and entry asset checks.

- [ ] **Step 6: Extend the runtime verifier**

In `scripts/verify-lan-runtime.ps1`, after the health check:

```powershell
$version = (docker exec $container node -e "fetch('http://127.0.0.1:8787/api/version').then(r => r.text()).then(process.stdout.write)") -join ""
if ($version -notmatch '"commitSha"') { Fail "运行版本接口缺少提交信息" }
docker exec $container npm run ready:check | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host "INFO: 验证镜像没有正式模型配置，ready:check 按契约返回未就绪"
}
```

The runtime verifier must validate the endpoint contract without requiring real model credentials.

- [ ] **Step 7: Run static tests and Compose validation**

Run:

```powershell
npx vitest run scripts/lan-deploy-policy.test.mjs
docker compose --env-file deploy/.env.example -f deploy/docker-compose.yml config --quiet
```

Expected: policy tests PASS. Compose validation may require a temporary nonempty `ENCRYPTION_KEY`; if so, create a temporary env copy outside the repository and validate against it.

- [ ] **Step 8: Run PowerShell parser validation**

Run:

```powershell
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path "scripts/lan-deploy.ps1"),
  [ref]$null,
  [ref]$errors
) | Out-Null
if ($errors.Count) { $errors | Format-List; exit 1 }
```

Expected: no parser errors.

- [ ] **Step 9: Commit**

```powershell
git add Dockerfile deploy/docker-compose.yml deploy/.env.example scripts/lan-deploy.ps1 scripts/verify-lan-runtime.ps1
git commit -m "feat: add traceable LAN deployment and rollback"
```

---

### Task 5: Operations Documentation and Ticket State

**Files:**
- Modify: `docs/guides/lan-deployment.md`
- Modify: `docs/guides/lan-operations.md`
- Modify: `.scratch/lan-release-closure/issues/04-reproducible-lan-deployment-and-runtime-version.md`

**Interfaces:**
- Documents: standard deploy, explicit rollback, version checks, preview mode, and Git push behavior.
- Ticket result: `in-review`, with implementation/test items checked and real-host acceptance items left unchecked.

- [ ] **Step 1: Update deployment documentation**

Replace the manual tag/edit/up sequence with:

```powershell
pwsh -File scripts/lan-deploy.ps1 `
  -EnvFile deploy/.env `
  -ContainerName customer-chat-analysis `
  -EntryUrl http://127.0.0.1:8787
```

Document:

- `git push` does not rebuild or replace a running container;
- official deployment rejects a dirty worktree;
- `-Preview` permits an explicitly labeled non-release build;
- `-RollbackImage <tag>` switches only the application image;
- `/api/version` is public release metadata;
- `/api/ready` remains administrator-only while `npm run ready:check` is container-local;
- successful output includes commit, image tag, image ID, runtime assets, and rollback command.

- [ ] **Step 2: Update operations documentation**

In upgrade and rollback sections, use `lan-deploy.ps1`. Keep backup/restore instructions for schema-incompatible rollback, and state that image rollback alone never deletes or rewrites data.

- [ ] **Step 3: Update the ticket**

Set status to:

```markdown
**Status:** in-review (2026-09-20) — 标准部署脚本、版本接口、就绪 CLI、版本/资源核验、失败回滚和自动化测试已完成；真实局域网发布、浏览器核验及发布/回滚/再发布演练待验收
```

Check only implementation-backed criteria:

- image tag and runtime full SHA support;
- failure detection and rollback code;
- development/LAN port distinction;
- automated idempotency/version/health/rollback policy tests;
- operations documentation.

Leave real host deployment, actual `172.16.20.178` browser display, persistent business data validation, live ready result, and full drill unchecked.

- [ ] **Step 4: Run complete verification**

Run:

```powershell
npm run check:installation
npm test
npm run typecheck
npm run lint
npm run build
npm run db:check
npm run smoke
git diff --check
```

Expected:

- all tests PASS;
- typecheck/build/db/smoke exit `0`;
- lint has no errors;
- no whitespace errors.

- [ ] **Step 5: Commit**

```powershell
git add docs/guides/lan-deployment.md docs/guides/lan-operations.md .scratch/lan-release-closure/issues/04-reproducible-lan-deployment-and-runtime-version.md
git commit -m "docs: document traceable LAN release workflow"
```

