# Section Configuration Versions and V1 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add immutable, auditable configuration snapshots for every analysis section, migrate the current live configuration into each section's V1, and bind existing jobs to those V1 snapshots without changing historical results.

**Architecture:** Keep the existing live `analysis_sections`, `analysis_fields`, and knowledge tables as the editable draft/current authoring store for compatibility. Add `analysis_section_versions` as the immutable published snapshot store, with one current version per section and JSON snapshot columns for section metadata, fields, export settings, dependencies, knowledge content, and business rules. Add a nullable version foreign key to jobs during this expand phase; version lifecycle behavior lives in a focused service and repository boundaries, while HTTP routes only adapt input, authorization, and audit events.

**Tech Stack:** TypeScript, Express, SQLite via better-sqlite3, Vitest, existing immutable audit event service.

**Spec:** `.scratch/versioned-section-config-and-reception-import/spec.md`; `.scratch/versioned-section-config-and-reception-import/issues/01-section-config-versions-and-v1-migration.md`

## Global Constraints

- Published versions are immutable and permanently retained.
- Each section may have only one current enabled published version.
- Version snapshots must not contain model provider credentials, quotas, cooldowns, or health state.
- Existing jobs must be bound to content-equivalent V1 snapshots without re-analysis or result rewrites.
- Migrations are additive, idempotent, transactional, and must preserve the existing migration checksum lock.
- New business rules belong in services; routes must not contain persistence or lifecycle logic.
- Existing user changes in the working tree must be preserved.

---

### Task 1: Add the version schema and content-equivalent V1 migration

**Files:**
- Create: `src/server/db/migrations/018-section-config-versions.ts`
- Modify: `src/server/db/migrations/index.ts`
- Modify: `src/server/db/migrations/migrations.lock.json`
- Test: `src/server/db/migrations/migrations.test.ts`

**Interfaces:**
- Produces `analysis_section_versions` with immutable snapshot columns and unique `(section_id, version_number)`.
- Produces nullable `jobs.section_config_version_id`.
- Produces `analysis_section_versions_current` uniqueness enforcement so one section has at most one current version.
- Produces idempotent V1 rows and job backfill behavior for later services.

- [ ] **Step 1: Write failing migration tests**

Add migration tests that:

```ts
it("creates immutable section version storage and migrates each current section to V1", () => {
  applyLegacyBaseline(db);
  db.exec(`
    INSERT INTO analysis_sections
      (id, parent_id, name, prompt, output_schema_json, source_fields_json,
       sort_order, is_enabled, image_enabled, created_at, updated_at)
    VALUES ('section-a', NULL, '板块 A', 'prompt-a', '[{"key":"result","label":"结果","type":"string"}]',
      '["平台"]', 1, 1, 1, 'before', 'before');
    INSERT INTO analysis_fields
      (id, section_id, key, label, field_type, prompt, options_json, output_column,
       is_required, image_enabled, depends_on_json, sort_order, is_enabled,
       execution_type, export_enabled, created_at, updated_at)
    VALUES ('field-a', 'section-a', 'result', '结果', 'string', 'field-prompt', '[]',
      '结果', 1, 1, '[]', 0, 1, 'ai', 1, 'before', 'before');
    INSERT INTO jobs
      (id, original_filename, source_path, section_id, section_name, status, created_at, updated_at)
    VALUES ('job-a', 'a.xlsx', 'a.xlsx', 'section-a', '板块 A', 'completed', 'before', 'before');
  `);

  runMigrations(db);

  const version = db.prepare(`
    SELECT section_id, version_number, status, is_current,
           section_snapshot_json, fields_snapshot_json
    FROM analysis_section_versions
    WHERE section_id = 'section-a'
  `).get();
  expect(version).toMatchObject({
    section_id: "section-a",
    version_number: 1,
    status: "published",
    is_current: 1,
  });
  expect(JSON.parse(version.section_snapshot_json)).toMatchObject({
    name: "板块 A",
    prompt: "prompt-a",
    sourceFields: ["平台"],
  });
  expect(JSON.parse(version.fields_snapshot_json)).toEqual([
    expect.objectContaining({ key: "result", prompt: "field-prompt" }),
  ]);
  expect(db.prepare("SELECT section_config_version_id FROM jobs WHERE id='job-a'").get())
    .toEqual({ section_config_version_id: expect.any(String) });
});

it("rerunning the migration does not duplicate V1 rows or change existing job bindings", () => {
  applyLegacyBaseline(db);
  db.exec(`INSERT INTO analysis_sections
    (id, name, prompt, output_schema_json, source_fields_json, created_at, updated_at)
    VALUES ('section-a', '板块 A', 'prompt-a', '[]', '[]', 'before', 'before')`);
  runMigrations(db);
  const first = db.prepare("SELECT id FROM analysis_section_versions WHERE section_id='section-a'").get().id;
  db.prepare("UPDATE jobs SET section_config_version_id = ? WHERE section_id = 'section-a'").run(first);
  runMigrations(db);
  expect(db.prepare("SELECT COUNT(*) AS count FROM analysis_section_versions WHERE section_id='section-a'").get())
    .toEqual({ count: 1 });
  expect(db.prepare("SELECT section_config_version_id FROM jobs WHERE section_id='section-a'").all())
    .toEqual([]);
});
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `npx vitest run src/server/db/migrations/migrations.test.ts`

Expected: FAIL because migration version 18, the version table, and the job column do not yet exist.

- [ ] **Step 3: Implement migration 018**

Create the additive migration with:

```ts
export function applySectionConfigVersions(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS analysis_section_versions (
      id TEXT PRIMARY KEY,
      section_id TEXT NOT NULL REFERENCES analysis_sections(id) ON DELETE RESTRICT,
      version_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
      is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
      section_snapshot_json TEXT NOT NULL,
      fields_snapshot_json TEXT NOT NULL,
      export_settings_json TEXT NOT NULL,
      dependencies_snapshot_json TEXT NOT NULL,
      knowledge_snapshot_json TEXT NOT NULL,
      business_rules_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT,
      archived_at TEXT,
      UNIQUE(section_id, version_number)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_section_versions_current
      ON analysis_section_versions(section_id)
      WHERE is_current = 1;
  `);
  const jobColumns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!jobColumns.some((column) => column.name === "section_config_version_id")) {
    db.exec("ALTER TABLE jobs ADD COLUMN section_config_version_id TEXT REFERENCES analysis_section_versions(id)");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_section_config_version ON jobs(section_config_version_id)");
  // The V1 row is created from the current authoring tables exactly once per section.
  // Snapshot JSON is deliberately limited to business configuration and never reads model_configs.
  const sections = db.prepare("SELECT * FROM analysis_sections ORDER BY id").all() as any[];
  const insertVersion = db.prepare(`INSERT OR IGNORE INTO analysis_section_versions
    (id, section_id, version_number, status, is_current, section_snapshot_json,
     fields_snapshot_json, export_settings_json, dependencies_snapshot_json,
     knowledge_snapshot_json, business_rules_json, created_at, updated_at, published_at)
    VALUES (?, ?, 1, 'published', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const section of sections) {
    const versionId = `section-version-${section.id}-v1`;
    const fields = db.prepare(
      "SELECT * FROM analysis_fields WHERE section_id = ? ORDER BY sort_order, key",
    ).all(section.id);
    const knowledgeBases = db.prepare(
      "SELECT * FROM knowledge_bases WHERE section_id = ? ORDER BY id",
    ).all(section.id) as any[];
    const knowledge = knowledgeBases.map((base) => ({
      ...base,
      columns: JSON.parse(base.column_schema_json || "[]"),
      items: db.prepare(
        "SELECT * FROM knowledge_items WHERE knowledge_base_id = ? ORDER BY path_key, id",
      ).all(base.id).map((item: any) => ({
        ...item,
        values: JSON.parse(item.values_json || "{}"),
      })),
    }));
    const timestamp = section.updated_at || new Date().toISOString();
    insertVersion.run(
      versionId,
      section.id,
      JSON.stringify({
        id: section.id,
        parentId: section.parent_id,
        name: section.name,
        prompt: section.prompt,
        outputSchema: JSON.parse(section.output_schema_json || "[]"),
        sourceFields: JSON.parse(section.source_fields_json || "[]"),
        imageEnabled: section.image_enabled !== 0,
        sortOrder: section.sort_order,
        isEnabled: section.is_enabled !== 0,
      }),
      JSON.stringify(fields),
      JSON.stringify({
        outputColumns: fields.filter((field: any) => field.export_enabled !== 0)
          .map((field: any) => ({ key: field.key, outputColumn: field.output_column })),
      }),
      JSON.stringify(fields.map((field: any) => ({
        key: field.key,
        dependsOn: JSON.parse(field.depends_on_json || "[]"),
      }))),
      JSON.stringify(knowledge),
      JSON.stringify({}),
      timestamp,
      timestamp,
      timestamp,
    );
  }
  db.prepare(`
    UPDATE jobs
    SET section_config_version_id = (
      SELECT v.id FROM analysis_section_versions v
      WHERE v.section_id = jobs.section_id AND v.version_number = 1
    )
    WHERE section_config_version_id IS NULL AND section_id IS NOT NULL
  `).run();
}
```

Keep the `UPDATE jobs` backfill conditional so a rerun never overwrites an existing binding. Do not add model provider or model configuration data to any snapshot.

- [ ] **Step 4: Register migration 018 and refresh its checksum**

Import `applySectionConfigVersions`, append `{ version: 18, name: "section-config-versions", up: applySectionConfigVersions }`, and set `currentSchemaVersion = 18`. Recompute only the new entry in `src/server/db/migrations/migrations.lock.json` using the repository's existing checksum convention.

- [ ] **Step 5: Run focused migration tests**

Run: `npx vitest run src/server/db/migrations/migrations.test.ts`

Expected: PASS, including the existing version-1 upgrade, rollback, checksum, and audit tests.

- [ ] **Step 6: Commit the schema deliverable**

Run:

```powershell
git add src/server/db/migrations/018-section-config-versions.ts src/server/db/migrations/index.ts src/server/db/migrations/migrations.lock.json src/server/db/migrations/migrations.test.ts
git commit -m "feat: add immutable section configuration versions"
```

### Task 2: Add shared version contracts and a version lifecycle service

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/server/services/section-config-version-service.ts`
- Test: `src/server/services/section-config-version-service.test.ts`

**Interfaces:**
- Produces `SectionConfigVersion`, `SectionConfigVersionStatus`, and `SectionConfigVersionSummary` contracts.
- Produces `listSectionVersions(sectionId)`, `getSectionVersion(id)`, `createDraftVersion(sectionId)`, `publishSectionVersion(id)`, `archiveSectionVersion(id)`, `restoreSectionVersion(id)`, and `activateSectionVersion(id)`.
- Lifecycle functions return immutable snapshot data and throw stable Chinese validation errors for invalid transitions.

- [ ] **Step 1: Write failing service tests**

Cover:

```ts
it("publishes a draft as the next section-local version and makes it current");
it("rejects edits to published and archived snapshots");
it("archives the current version only after another published version is current");
it("restores an archived version to published but does not activate it automatically");
it("activation clears the old current marker atomically");
it("does not include model credentials or runtime pool state in snapshots");
```

Seed one section, fields, and a knowledge base/items in each test. Assert the version number, status, current marker, and parsed snapshot contents directly from SQLite.

- [ ] **Step 2: Run the focused service tests and confirm failure**

Run: `npx vitest run src/server/services/section-config-version-service.test.ts`

Expected: FAIL because the service and shared contracts do not exist.

- [ ] **Step 3: Implement snapshot assembly and lifecycle transitions**

Implement a private `buildCurrentSnapshot(sectionId)` that reads only `analysis_sections`, `analysis_fields`, `knowledge_bases`, and `knowledge_items`. Normalize database rows into JSON-safe business objects; omit encrypted model configuration columns and runtime state. Use a transaction for every publish, archive, restore, and activate operation. Enforce:

- draft creation uses the next `MAX(version_number) + 1`;
- publish changes only drafts to `published`, never existing published rows;
- activation requires `published`, sets exactly one current row;
- archive clears `is_current` and sets `archived_at`;
- restore changes only archived rows to published;
- existing published rows cannot be updated or deleted.

- [ ] **Step 4: Run the focused service tests**

Run: `npx vitest run src/server/services/section-config-version-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the lifecycle service**

Run:

```powershell
git add src/shared/types.ts src/server/services/section-config-version-service.ts src/server/services/section-config-version-service.test.ts
git commit -m "feat: manage section configuration version lifecycle"
```

### Task 3: Expose version lifecycle endpoints with authorization and audit events

**Files:**
- Modify: `src/server/app.ts`
- Test: `src/server/auth/configuration-admin.test.ts`

**Interfaces:**
- `GET /api/sections/:id/versions`
- `GET /api/section-config-versions/:id`
- `POST /api/sections/:id/versions`
- `POST /api/section-config-versions/:id/publish`
- `POST /api/section-config-versions/:id/archive`
- `POST /api/section-config-versions/:id/restore`
- `POST /api/section-config-versions/:id/activate`

- [ ] **Step 1: Write failing authorization and audit tests**

Assert config/admin users can list and mutate versions, other roles receive `403`, invalid transitions return `400`, and each successful lifecycle action writes an audit event with target version id and section id metadata.

- [ ] **Step 2: Run the focused authorization tests and confirm failure**

Run: `npx vitest run src/server/auth/configuration-admin.test.ts`

Expected: FAIL because the version endpoints are not registered.

- [ ] **Step 3: Add route adapters**

Import the lifecycle functions, register read routes behind `canView`, write routes behind `canManageConfig`, call `auditRequest` after successful mutations with actions `config.version_create_draft`, `config.version_publish`, `config.version_archive`, `config.version_restore`, and `config.version_activate`, and use existing `ok`/`fail` response helpers.

- [ ] **Step 4: Run focused authorization tests**

Run: `npx vitest run src/server/auth/configuration-admin.test.ts`

Expected: PASS without exposing credentials or runtime model state.

- [ ] **Step 5: Commit the route deliverable**

Run:

```powershell
git add src/server/app.ts src/server/auth/configuration-admin.test.ts
git commit -m "feat: expose audited section version lifecycle"
```

### Task 4: Preserve job binding and add migration/export invariance coverage

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/server/db/repositories.ts`
- Test: `src/server/db/repositories.test.ts`
- Test: `src/server/services/excel-export-service.test.ts`
- Modify: `.scratch/versioned-section-config-and-reception-import/issues/01-section-config-versions-and-v1-migration.md`

**Interfaces:**
- `Job` includes `sectionConfigVersionId`.
- `getJob`, `listJobs`, and job creation/read paths expose the bound version id.
- Existing analysis and export reads continue to use the historical section configuration for this ticket, while the immutable version id is retained for later task-bound snapshot reads.

- [ ] **Step 1: Add failing repository and export invariance tests**

Create a V1-bound job with a historical analysis result, edit the live section authoring row afterward, and assert:

```ts
expect(getJob(job.id)?.sectionConfigVersionId).toBe(v1Id);
expect(exportedHistoricalResult).toEqual(exportedResultBeforeLiveEdit);
```

Also assert a job with no section remains compatible with legacy tests and does not receive a guessed version id.

- [ ] **Step 2: Run focused tests and confirm the missing contract**

Run: `npx vitest run src/server/db/repositories.test.ts src/server/services/excel-export-service.test.ts`

Expected: FAIL because the job mapping does not expose the new column and the invariant test cannot observe it.

- [ ] **Step 3: Map the version id without changing result semantics**

Add `sectionConfigVersionId` to the shared `Job` contract and repository job mappers. Keep legacy job creation signatures source-compatible; when a section is provided, resolve the current published version and store it, but do not overwrite an existing version binding during `assertJobSection`. Leave unbound legacy jobs unmodified until migration/backfill or a later explicit binding flow.

- [ ] **Step 4: Run focused repository and export tests**

Run: `npx vitest run src/server/db/repositories.test.ts src/server/services/excel-export-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit job binding coverage**

Run:

```powershell
git add src/shared/types.ts src/server/db/repositories.ts src/server/db/repositories.test.ts src/server/services/excel-export-service.test.ts .scratch/versioned-section-config-and-reception-import/issues/01-section-config-versions-and-v1-migration.md
git commit -m "feat: retain section version bindings on jobs"
```

### Task 5: Complete verification, migration evidence, and ticket status

**Files:**
- Modify: `.scratch/versioned-section-config-and-reception-import/issues/01-section-config-versions-and-v1-migration.md`
- Create: `.scratch/versioned-section-config-and-reception-import/evidence/2026-09-22-ticket-01-version-migration.json`

- [ ] **Step 1: Run the complete required checks**

Run:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npm run db:check
```

Expected: all commands exit with code 0.

- [ ] **Step 2: Run a clean-database migration drill**

Create a temporary SQLite database containing the legacy schema plus representative section, field, knowledge, and job rows. Run migrations twice, record counts and hashes of the V1 snapshots, and verify the second run does not change them. Store only counts, ids, statuses, and hashes in the evidence file; never store credentials, API keys, or file paths.

- [ ] **Step 3: Update ticket evidence and status**

Mark the completed acceptance criteria in the ticket, add the migration test names and command results, set the status to `in-review` until a reviewer confirms the implementation, and link the evidence JSON.

- [ ] **Step 4: Review the final diff**

Run:

```powershell
git status --short
git diff --check
git diff --stat HEAD~5..HEAD
```

Confirm no `.env`, database, backup, credential, or unrelated user change is staged or modified.
