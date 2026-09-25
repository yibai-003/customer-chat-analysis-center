import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrations";
import { ensureConversationId, formatShanghaiDate } from "./conversation-id-service";

let database: any;
const fixedNow = (value: string) => () => new Date(value);

beforeEach(() => {
  database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runMigrations(database);
});

afterEach(() => {
  database.close();
});

function insertRecord(input: {
  recordId: string;
  jobId: string;
  platformCode?: string;
}) {
  database.prepare(`
    INSERT INTO jobs (
      id, original_filename, source_path, platform_code,
      status, created_at, updated_at
    ) VALUES (?, 'test.xlsx', 'test.xlsx', ?, 'ready', 'now', 'now')
  `).run(input.jobId, input.platformCode ?? null);
  database.prepare(`
    INSERT INTO records (
      id, job_id, sheet_name, row_number, anchor_json, source_fields_json,
      image_path, status, review_status, review_note, created_at, updated_at
    ) VALUES (?, ?, 'Sheet1', 2, '{}', '{}', 'test.png', 'pending', 'pending', '', 'now', 'now')
  `).run(input.recordId, input.jobId);
}

describe("conversation ID assignment", () => {
  it("uses the Asia/Shanghai calendar date across the UTC boundary", () => {
    expect(formatShanghaiDate(new Date("2026-09-22T15:59:59.000Z"))).toBe("20260922");
    expect(formatShanghaiDate(new Date("2026-09-22T16:00:00.000Z"))).toBe("20260923");
  });

  it("assigns platform code, Shanghai date, and a six-character uppercase code", () => {
    insertRecord({ recordId: "record-format", jobId: "job-format", platformCode: "TMALL" });

    const conversationId = ensureConversationId(database, "record-format", {
      now: fixedNow("2026-09-22T16:00:00.000Z"),
      randomCode: () => "A1B2C3",
    });

    expect(conversationId).toBe("TMALL20260923A1B2C3");
    expect(database.prepare(`
      SELECT conversation_id, conversation_id_assigned_at
      FROM records WHERE id = 'record-format'
    `).get()).toEqual({
      conversation_id: "TMALL20260923A1B2C3",
      conversation_id_assigned_at: "2026-09-22T16:00:00.000Z",
    });
  });

  it("requires historical tasks to receive a platform backfill", () => {
    insertRecord({ recordId: "record-no-platform", jobId: "job-no-platform" });

    expect(() => ensureConversationId(database, "record-no-platform", {
      randomCode: () => "ABC123",
    })).toThrow("历史任务缺少平台，请先补录平台");
  });

  it("retries a globally colliding code and then persists the next candidate", () => {
    insertRecord({ recordId: "record-first", jobId: "job-first", platformCode: "JD" });
    insertRecord({ recordId: "record-second", jobId: "job-second", platformCode: "JD" });
    const now = fixedNow("2026-09-22T04:00:00.000Z");

    expect(ensureConversationId(database, "record-first", {
      now,
      randomCode: () => "AAAAAA",
    })).toBe("JD20260922AAAAAA");

    const candidates = ["AAAAAA", "BBBBBB"];
    expect(ensureConversationId(database, "record-second", {
      now,
      randomCode: () => candidates.shift()!,
    })).toBe("JD20260922BBBBBB");
  });

  it("fails clearly after the bounded collision retry limit", () => {
    insertRecord({ recordId: "record-taken", jobId: "job-taken", platformCode: "PDD" });
    insertRecord({ recordId: "record-exhausted", jobId: "job-exhausted", platformCode: "PDD" });
    const now = fixedNow("2026-09-22T04:00:00.000Z");
    ensureConversationId(database, "record-taken", {
      now,
      randomCode: () => "CCCCCC",
    });

    expect(() => ensureConversationId(database, "record-exhausted", {
      now,
      randomCode: () => "CCCCCC",
      maxAttempts: 2,
    })).toThrow("会话 ID 生成失败：随机码碰撞次数超过上限");
    expect(database.prepare(
      "SELECT conversation_id FROM records WHERE id = 'record-exhausted'",
    ).get()).toEqual({ conversation_id: null });
  });

  it("always reuses an assigned ID without consuming another random code", () => {
    insertRecord({ recordId: "record-stable", jobId: "job-stable", platformCode: "DY" });
    const assigned = ensureConversationId(database, "record-stable", {
      now: fixedNow("2026-09-22T04:00:00.000Z"),
      randomCode: () => "D1E2F3",
    });
    let randomCalls = 0;

    const reused = ensureConversationId(database, "record-stable", {
      now: fixedNow("2027-01-01T00:00:00.000Z"),
      randomCode: () => {
        randomCalls += 1;
        return "ZZZZZZ";
      },
    });

    expect(reused).toBe(assigned);
    expect(randomCalls).toBe(0);
  });
});
