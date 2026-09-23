import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { db, initDb } from "../db/client";
import { addRecords, createJob, getJob, getRecord, listRecords, listSections } from "../db/repositories";
import { attachConversationTestPlatform } from "../testing/conversation-platform-fixture";
import { bootstrapFirstAdmin, createUser } from "./identity-service";
import type { UserRole } from "../../shared/types";

interface RoleAccount {
  username: string;
  password: string;
  displayName: string;
  role: UserRole;
}

const ACCOUNTS: RoleAccount[] = [
  { username: "admin", password: "test-password-123", displayName: "管理员", role: "admin" },
  { username: "config-user", password: "config-password-123", displayName: "配置人员", role: "config" },
  { username: "operator-user", password: "operator-password-123", displayName: "操作人员", role: "operator" },
  { username: "reviewer-user", password: "reviewer-password-123", displayName: "审核人员", role: "reviewer" },
  { username: "readonly-user", password: "readonly-password-123", displayName: "只读人员", role: "readonly" },
];

const analyzeJobRunner = vi.fn(async () => ({ total: 0, completed: 0, failed: 0, needsReview: 0 }));
const retryFailedJobStarter = vi.fn(async () => null);

let server: Server;
let baseUrl: string;
let cookies: Record<string, string> = {};
let jobId: string;
let recordId: string;
let sectionId: string;
const imageDir = path.join(os.tmpdir(), `客服解析-authorization-matrix-${process.pid}-${Date.now()}`);
const imagePath = path.join(imageDir, "聊天截图.png");
const workbookPaths: string[] = [];
let workbookBuffer: Buffer;

function resetIdentity() {
  db.exec("DELETE FROM user_sessions; DELETE FROM users;");
  const [admin, ...rest] = ACCOUNTS;
  bootstrapFirstAdmin({ username: admin.username, password: admin.password, displayName: admin.displayName });
  for (const account of rest) {
    createUser({
      username: account.username,
      password: account.password,
      displayName: account.displayName,
      role: account.role,
    });
  }
}

function seedFixture() {
  db.exec("DELETE FROM analysis_field_runs; DELETE FROM analysis_runs; DELETE FROM import_jobs; DELETE FROM jobs;");
  const section = listSections().find((candidate) => candidate.parentId)!;
  sectionId = section.id;
  const jobSourcePath = path.join(os.tmpdir(), `authorization-matrix-${crypto.randomUUID()}.xlsx`);
  fs.writeFileSync(jobSourcePath, workbookBuffer);
  workbookPaths.push(jobSourcePath);
  const job = createJob("authorization-matrix.xlsx", jobSourcePath, { id: section.id, name: section.name });
  attachConversationTestPlatform(job.id);
  addRecords(job.id, [{
    sheetName: "Sheet1",
    rowNumber: 2,
    anchor: {},
    sourceFields: { 客服: "小张" },
    imagePath,
  }]);
  jobId = job.id;
  recordId = listRecords(job.id)[0]!.id;
}

async function login(username: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`登录失败：${response.status}`);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

async function request(pathname: string, options: { cookie?: string; method?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function cookieFor(role: string) {
  return cookies[role]!;
}

beforeAll(async () => {
  initDb();
  fs.mkdirSync(imageDir, { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["客服", "日期"]);
  sheet.addRow(["小张", "2026-09-17"]);
  workbookBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
  server = createApp({ analyzeJobRunner, retryFailedJobStarter } as never).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  vi.clearAllMocks();
  resetIdentity();
  seedFixture();
  cookies = {};
  for (const account of ACCOUNTS) cookies[account.role] = await login(account.username, account.password);
});

afterAll(async () => {
  fs.rmSync(imageDir, { recursive: true, force: true });
  for (const file of workbookPaths.splice(0)) fs.rmSync(file, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

describe("task and review authorization", () => {
  it("rejects anonymous callers and admits every authenticated role to shared reads", async () => {
    expect((await request("/api/jobs")).status).toBe(401);
    expect((await request(`/api/jobs/${jobId}`)).status).toBe(401);
    expect((await request(`/api/records/${recordId}`)).status).toBe(401);

    for (const role of ["admin", "config", "operator", "reviewer", "readonly"]) {
      expect((await request("/api/jobs", { cookie: cookieFor(role) })).status, role).toBe(200);
      expect((await request(`/api/jobs/${jobId}`, { cookie: cookieFor(role) })).status, role).toBe(200);
      expect((await request(`/api/jobs/${jobId}/records`, { cookie: cookieFor(role) })).status, role).toBe(200);
      expect((await request(`/api/records/${recordId}`, { cookie: cookieFor(role) })).status, role).toBe(200);
      const image = await fetch(`${baseUrl}/api/records/${recordId}/image`, { headers: { cookie: cookieFor(role) } });
      expect(image.status, role).toBe(200);
      expect(await image.arrayBuffer()).toBeTruthy();
    }
    expect((await fetch(`${baseUrl}/api/records/${recordId}/image`)).status).toBe(401);
  });

  it("allows only operators and administrators to import workbooks", async () => {
    for (const role of ["admin", "operator"]) {
      const preview = await request("/api/jobs/import-preview", { cookie: cookieFor(role), method: "POST" });
      expect(preview.status, role).toBe(400);
      expect(preview.body.success).toBe(false);
    }
    for (const role of ["config", "reviewer", "readonly"]) {
      const preview = await request("/api/jobs/import-preview", { cookie: cookieFor(role), method: "POST" });
      expect(preview.status, role).toBe(403);
    }
    expect((await request("/api/import-jobs/missing", { cookie: cookieFor("operator") })).status).toBe(404);
    expect((await request("/api/import-jobs/missing", { cookie: cookieFor("reviewer") })).status).toBe(403);
  });

  it("allows only operators and administrators to run the analysis lifecycle", async () => {
    const started = await request(`/api/jobs/${jobId}/analyze`, {
      cookie: cookieFor("operator"),
      method: "POST",
      body: { sectionId },
    });
    expect(started.status).toBe(200);
    expect(analyzeJobRunner).toHaveBeenCalledTimes(1);

    for (const role of ["reviewer", "readonly", "config"]) {
      expect((await request(`/api/jobs/${jobId}/analyze`, { cookie: cookieFor(role), method: "POST", body: { sectionId } })).status, role).toBe(403);
      expect((await request(`/api/jobs/${jobId}/pause`, { cookie: cookieFor(role), method: "POST" })).status, role).toBe(403);
      expect((await request(`/api/jobs/${jobId}/cancel`, { cookie: cookieFor(role), method: "POST" })).status, role).toBe(403);
      expect((await request(`/api/jobs/${jobId}/retry-failed`, { cookie: cookieFor(role), method: "POST" })).status, role).toBe(403);
      expect((await request("/api/system/analysis-capacity", { cookie: cookieFor(role) })).status, role).toBe(403);
    }
    expect(analyzeJobRunner).toHaveBeenCalledTimes(1);
    expect(retryFailedJobStarter).not.toHaveBeenCalled();
    expect(getJob(jobId)?.status).toBe("ready");

    expect((await request(`/api/jobs/${jobId}/pause`, { cookie: cookieFor("admin"), method: "POST" })).status).toBe(200);
    expect((await request(`/api/jobs/${jobId}/retry-failed`, { cookie: cookieFor("operator"), method: "POST" })).status).toBe(200);
    expect(retryFailedJobStarter).toHaveBeenCalledTimes(1);
    expect((await request("/api/system/analysis-capacity", { cookie: cookieFor("operator") })).status).toBe(200);
  });

  it("allows only reviewers and administrators to save reviews and leaves data untouched on denial", async () => {
    const before = getRecord(recordId)!;
    for (const role of ["operator", "readonly", "config"]) {
      const denied = await request(`/api/records/${recordId}`, {
        cookie: cookieFor(role),
        method: "PATCH",
        body: { sectionId, humanResult: { 结论: "篡改" }, reviewStatus: "confirmed", status: "completed" },
      });
      expect(denied.status, role).toBe(403);
    }
    expect(getRecord(recordId)!.reviewStatus).toBe(before.reviewStatus);
    expect(db.prepare("SELECT COUNT(*) n FROM record_section_reviews WHERE record_id = ?").get(recordId)).toEqual({ n: 0 });

    const saved = await request(`/api/records/${recordId}`, {
      cookie: cookieFor("reviewer"),
      method: "PATCH",
      body: { sectionId, humanResult: { 结论: "已确认" }, reviewStatus: "confirmed", reviewNote: "复核通过", status: "completed" },
    });
    expect(saved.status).toBe(200);
    expect(getRecord(recordId)!.reviewStatus).toBe("confirmed");
    expect(getRecord(recordId)!.sectionReviews?.[sectionId]?.reviewNote).toBe("复核通过");
  });

  it("restricts export to operators, reviewers and administrators without granting read-only users", async () => {
    for (const role of ["admin", "operator", "reviewer"]) {
      const exported = await request(`/api/jobs/${jobId}/export`, { cookie: cookieFor(role) });
      expect(exported.status, role).toBe(200);
    }
    for (const role of ["readonly", "config"]) {
      expect((await request(`/api/jobs/${jobId}/export`, { cookie: cookieFor(role) })).status, role).toBe(403);
    }
    expect((await request(`/api/jobs/${jobId}/export?sections=${sectionId},refund`, {
      cookie: cookieFor("operator"),
    })).status).toBe(400);
    expect((await request(`/api/jobs/${jobId}/export`)).status).toBe(401);
  });

  it("restricts task deletion to operators and administrators and keeps denied tasks intact", async () => {
    for (const role of ["reviewer", "readonly", "config"]) {
      expect((await request(`/api/jobs/${jobId}`, { cookie: cookieFor(role), method: "DELETE" })).status, role).toBe(403);
      expect(getJob(jobId), role).toBeTruthy();
    }
    expect((await request(`/api/jobs/${jobId}`, { cookie: cookieFor("operator"), method: "DELETE" })).status).toBe(200);
    expect(getJob(jobId)).toBeUndefined();
  });

  it("restricts configuration writes and readiness checks by capability", async () => {
    const denied = await request("/api/sections", {
      cookie: cookieFor("operator"),
      method: "POST",
      body: { id: "authz-temp", name: "授权临时板块", prompt: "" },
    });
    expect(denied.status).toBe(403);
    expect(db.prepare("SELECT id FROM analysis_sections WHERE id = 'authz-temp'").get()).toBeUndefined();

    const allowed = await request("/api/sections", {
      cookie: cookieFor("config"),
      method: "POST",
      body: { id: "authz-temp", name: "授权临时板块", prompt: "" },
    });
    expect(allowed.status).toBe(200);
    expect((await request("/api/sections/authz-temp", { cookie: cookieFor("operator"), method: "DELETE" })).status).toBe(403);
    expect((await request("/api/sections/authz-temp", { cookie: cookieFor("admin"), method: "DELETE" })).status).toBe(200);

    expect((await request("/api/ready", { cookie: cookieFor("reviewer") })).status).toBe(403);
    expect((await request("/api/ready", { cookie: cookieFor("readonly") })).status).toBe(403);
    expect([200, 503]).toContain((await request("/api/ready", { cookie: cookieFor("admin") })).status);
  });

  it("audits allowed actions and denials with actor, action, target and outcome but no secrets", async () => {
    const existing = new Set((db.prepare("SELECT id FROM audit_events").all() as Array<{ id: string }>).map((row) => row.id));
    await request(`/api/jobs/${jobId}/analyze`, { cookie: cookieFor("operator"), method: "POST", body: { sectionId } });
    await request(`/api/records/${recordId}`, {
      cookie: cookieFor("reviewer"),
      method: "PATCH",
      body: { sectionId, humanResult: { 结论: "ok" }, reviewStatus: "confirmed", status: "completed" },
    });
    const exportAllowed = await request(`/api/jobs/${jobId}/export`, { cookie: cookieFor("reviewer") });
    expect(exportAllowed.status, JSON.stringify(exportAllowed.body)).toBe(200);
    const exportDenied = await request(`/api/jobs/${jobId}/export`, { cookie: cookieFor("readonly") });
    expect(exportDenied.status).toBe(403);
    await request(`/api/jobs/${jobId}/pause`, { cookie: cookieFor("readonly"), method: "POST" });

    const events = (db.prepare("SELECT * FROM audit_events ORDER BY occurred_at").all() as Array<{
      id: string;
      actor_user_id: string | null;
      action: string;
      target_type: string | null;
      target_id: string | null;
      outcome: string;
      metadata_json: string;
    }>).filter((event) => !existing.has(event.id));
    const byAction = (action: string, outcome: string) => events.filter((event) => event.action === action && event.outcome === outcome);
    expect(byAction("task.start_analysis", "success")).toHaveLength(1);
    expect(byAction("review.save", "success")).toHaveLength(1);
    expect(byAction("task.export", "success")).toHaveLength(1);
    expect(byAction("task.export", "failure")).toHaveLength(1);
    expect(byAction("task.pause", "failure")).toHaveLength(1);

    const operator = db.prepare("SELECT id FROM users WHERE username = 'operator-user'").get() as { id: string };
    const reviewer = db.prepare("SELECT id FROM users WHERE username = 'reviewer-user'").get() as { id: string };
    const readonly = db.prepare("SELECT id FROM users WHERE username = 'readonly-user'").get() as { id: string };
    expect(byAction("task.start_analysis", "success")[0]).toMatchObject({
      actor_user_id: operator.id,
      target_type: "job",
      target_id: jobId,
    });
    expect(byAction("review.save", "success")[0]).toMatchObject({
      actor_user_id: reviewer.id,
      target_type: "record",
      target_id: recordId,
    });
    const exportDenial = byAction("task.export", "failure")[0]!;
    expect(exportDenial).toMatchObject({ actor_user_id: readonly.id, target_id: jobId });
    expect(JSON.parse(exportDenial.metadata_json)).toMatchObject({ capability: "task:export", reason: "forbidden" });

    const serialized = JSON.stringify(events);
    for (const secret of ["operator-password-123", "reviewer-password-123", "test-password-123", "password_hash", "cc_sid"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
