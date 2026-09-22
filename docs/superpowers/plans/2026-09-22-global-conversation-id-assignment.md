# Global Conversation ID Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assign one permanent, globally unique conversation ID to every record the first time it enters `completed` or `needs_review`.

**Architecture:** Add nullable conversation-ID columns and a partial unique index to `records`. A focused conversation-ID service will format the Asia/Shanghai date, generate bounded random candidates, and atomically claim an ID inside the existing `updateRecord` transaction. Every analysis and review path already converges on `updateRecord`, so the behavior remains section-independent and retries reuse the persisted ID.

**Tech Stack:** TypeScript, better-sqlite3, Node.js `crypto`, Vitest.

**Spec:** `E:\客服解析中心\.scratch\versioned-section-config-and-reception-import\issues\03-global-conversation-id-assignment.md`

## Global Constraints

- Conversation IDs are shared system business identifiers for every analysis section.
- Format is platform code + Asia/Shanghai assignment date `yyyyMMdd` + six uppercase letters or digits.
- Assignment occurs only on first transition to `completed` or `needs_review`.
- Assignment and status transition must commit or roll back as one atomic unit.
- The database must enforce global uniqueness.
- Candidate collisions retry a bounded number of times and exhaustion must leave the prior status unchanged.
- Existing IDs never change during retries, reanalysis, exports, status round-trips, or section-version activation changes.
- Historical jobs without a platform must return an explicit backfill-required error.

---

### Task 1: Add conversation-ID persistence

**Files:**
- Create: `src/server/db/migrations/021-global-conversation-id.ts`
- Modify: `src/server/db/migrations/index.ts`
- Modify: `src/server/db/migrations/migrations.lock.json`
- Modify: `src/server/db/migrations/migrations.test.ts`
- Modify: `src/server/services/restore-verification.test.ts`

**Interfaces:**
- Produces nullable `records.conversation_id` and `records.conversation_id_assigned_at`.
- Produces partial unique index `idx_records_conversation_id` for non-null IDs.
- Advances `currentSchemaVersion` from 20 to 21.

- [ ] **Step 1: Write the failing migration test**

```ts
expect(db.prepare("PRAGMA table_info(records)").all()).toEqual(expect.arrayContaining([
  expect.objectContaining({ name: "conversation_id" }),
  expect.objectContaining({ name: "conversation_id_assigned_at" }),
]));
expect(() => {
  db.prepare("UPDATE records SET conversation_id = 'TEST20260922ABC123' WHERE id = ?").run(firstId);
  db.prepare("UPDATE records SET conversation_id = 'TEST20260922ABC123' WHERE id = ?").run(secondId);
}).toThrow(/UNIQUE constraint failed/);
```

- [ ] **Step 2: Run the focused migration test and confirm schema version 20 fails the new assertions**

Run: `npm test -- --run src/server/db/migrations/migrations.test.ts`

- [ ] **Step 3: Add migration 21, register it, update the immutable digest, and update restore-version expectations**

- [ ] **Step 4: Run migration and migration-immutability tests**

Run: `npm test -- --run src/server/db/migrations/migrations.test.ts src/server/db/migrations/migrations-immutability.test.ts src/server/services/restore-verification.test.ts`

### Task 2: Implement deterministic ID generation and collision handling

**Files:**
- Create: `src/server/services/conversation-id-service.ts`
- Create: `src/server/services/conversation-id-service.test.ts`

**Interfaces:**
- Produces `formatShanghaiDate(date: Date): string`.
- Produces `ensureConversationId(database, recordId, dependencies?): string`.
- `dependencies` supports `now`, `randomCode`, and `maxAttempts` for deterministic tests.
- Throws clear errors for missing platform, invalid random code, and retry exhaustion.

- [ ] **Step 1: Write failing unit tests for Shanghai midnight boundaries and candidate format**

```ts
expect(formatShanghaiDate(new Date("2026-09-22T15:59:59.000Z"))).toBe("20260922");
expect(formatShanghaiDate(new Date("2026-09-22T16:00:00.000Z"))).toBe("20260923");
```

- [ ] **Step 2: Run the service test and confirm the module is missing**

Run: `npm test -- --run src/server/services/conversation-id-service.test.ts`

- [ ] **Step 3: Implement the formatter and bounded six-character candidate generator**

- [ ] **Step 4: Add failing database-backed tests for collision retry and retry exhaustion**

- [ ] **Step 5: Implement `ensureConversationId` with `UPDATE ... WHERE conversation_id IS NULL`, uniqueness-error retry, and persisted-ID reread**

- [ ] **Step 6: Run the focused service test**

Run: `npm test -- --run src/server/services/conversation-id-service.test.ts`

### Task 3: Make final-status transitions atomic and idempotent

**Files:**
- Modify: `src/server/db/repositories.ts`
- Modify: `src/server/db/repositories.test.ts`
- Modify: `src/shared/types.ts`

**Interfaces:**
- `updateRecord(id, input, conversationIdDependencies?)` assigns before committing a final status.
- `RecordSummary` and `RecordDetail` expose `conversationId` and `conversationIdAssignedAt`.
- Non-final states preserve a null ID; final-state round-trips reuse the original ID.

- [ ] **Step 1: Write failing repository tests for completed, needs-review, non-final, and missing-platform transitions**

- [ ] **Step 2: Run repository tests and confirm records currently lack conversation IDs**

Run: `npm test -- --run src/server/db/repositories.test.ts`

- [ ] **Step 3: Call `ensureConversationId` from inside the existing `updateRecord` transaction before final-state writes**

- [ ] **Step 4: Extend record mapping and shared types**

- [ ] **Step 5: Add tests proving retry, reanalysis-style status round-trips, and repeated final transitions reuse the first ID**

- [ ] **Step 6: Run repository tests**

Run: `npm test -- --run src/server/db/repositories.test.ts`

### Task 4: Verify concurrency and cross-version stability

**Files:**
- Create: `src/server/services/conversation-id-integration.test.ts`
- Modify: `src/server/services/section-config-version-service.test.ts` only if an existing helper is required.

**Interfaces:**
- Uses real repository status transitions and real SQLite uniqueness enforcement.
- Demonstrates two competing transitions for one record return one persisted ID.
- Demonstrates activating a different current section version does not mutate historical record IDs.

- [ ] **Step 1: Write failing integration tests for competing final transitions and version activation**

- [ ] **Step 2: Run the integration test and confirm the missing assignment behavior**

Run: `npm test -- --run src/server/services/conversation-id-integration.test.ts`

- [ ] **Step 3: Make the smallest repository/service adjustment needed for both tests**

- [ ] **Step 4: Run the integration and related section-version tests**

Run: `npm test -- --run src/server/services/conversation-id-integration.test.ts src/server/services/section-config-version-service.test.ts`

### Task 5: Verify the complete ticket

**Files:**
- Modify only files required by failures discovered during verification.

**Interfaces:**
- No new production interface.

- [ ] **Step 1: Run type checking**

Run: `npm run typecheck -- --pretty false`

- [ ] **Step 2: Run focused ticket tests**

Run: `npm test -- --run src/server/db/migrations/migrations.test.ts src/server/db/migrations/migrations-immutability.test.ts src/server/db/repositories.test.ts src/server/services/conversation-id-service.test.ts src/server/services/conversation-id-integration.test.ts`

- [ ] **Step 3: Run the full suite**

Run: `npm test`

- [ ] **Step 4: Run build and diff checks**

Run: `npm run build`

Run: `git diff --check`

- [ ] **Step 5: Commit the completed ticket on `feat/global-conversation-id-assignment`**

```bash
git add docs/superpowers/plans/2026-09-22-global-conversation-id-assignment.md src
git commit -m "feat: assign global conversation ids"
```
