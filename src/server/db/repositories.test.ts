import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { db, initDb } from "./client";
import {
  acquireJobRun,
  createJob,
  deleteJob,
  getJob,
  getRecord,
  addRecords,
  updateRecord,
  assertJobSection,
  requestJobCancel,
  requestJobPause,
  updateJobSection,
  createImportJob,
  getImportJob,
  claimImportJob,
  updateImportJob,
  listRecordsPage,
  listRecords,
  countActiveJobRuns,
  recoverStaleJobRuns,
  releaseJobRun,
  listBatchRecordIds,
  createPlatform,
  listPlatforms,
  disablePlatform,
  restorePlatform,
} from "./repositories";
import { createDraftVersion, publishSectionVersion } from "../services/section-config-version-service";
import { upsertSection } from "./repositories";

let conversationFixtureSequence = 0;

function createConversationRecord(platformCode?: string) {
  conversationFixtureSequence += 1;
  const suffix = conversationFixtureSequence;
  const platform = platformCode
    ? createPlatform({ name: `会话平台 ${suffix}`, code: platformCode })
    : undefined;
  const job = createJob(
    `conversation-${suffix}.xlsx`,
    `conversation-${suffix}.xlsx`,
    undefined,
    platform,
  );
  addRecords(job.id, [{
    sheetName: "Sheet1",
    rowNumber: 2,
    anchor: {},
    sourceFields: {},
    imagePath: `conversation-${suffix}.png`,
  }]);
  return { job, record: listRecords(job.id)[0] };
}

describe("job repository", () => {
  beforeAll(() => initDb());

  it("creates a job with matching SQL columns and values", () => {
    const job = createJob("sample.xlsx", "sample.xlsx");
    expect(job.originalFilename).toBe("sample.xlsx");
    expect(job.status).toBe("ready");
    expect(job.sectionName).toBeNull();
  });

  it("maintains globally unique platforms and keeps disabled platforms restorable", () => {
    const platform = createPlatform({ name: "平台测试", code: "TEST" });
    expect(platform).toMatchObject({ name: "平台测试", code: "TEST", isEnabled: true });
    expect(() => createPlatform({ name: "重复代码", code: " test " })).toThrow("平台代码已存在");
    expect(disablePlatform(platform.id)).toMatchObject({ id: platform.id, isEnabled: false });
    expect(restorePlatform(platform.id)).toMatchObject({ id: platform.id, isEnabled: true });
    expect(listPlatforms().find((item) => item.id === platform.id)).toMatchObject({ code: "TEST" });
  });

  it("stores the selected platform snapshot on a bound task", () => {
    const platform = createPlatform({ name: "绑定平台", code: "BOUND" });
    const job = createJob("bound-platform.xlsx", "bound-platform.xlsx", { id: "refund", name: "退货分析" }, platform);
    expect(job).toMatchObject({
      platformId: platform.id,
      platformCode: "BOUND",
      platformName: "绑定平台",
    });
  });

  it("assigns a conversation ID only when a record enters a final analysis state", () => {
    const processing = createConversationRecord(`CIDPROC${Date.now()}`);
    const completed = createConversationRecord(`CIDCOMP${Date.now()}`);
    const needsReview = createConversationRecord(`CIDREVIEW${Date.now()}`);
    const now = () => new Date("2026-09-22T16:00:00.000Z");

    expect(updateRecord(processing.record.id, { status: "processing" })).toMatchObject({
      status: "processing",
      conversationId: null,
      conversationIdAssignedAt: null,
    });
    expect(updateRecord(processing.record.id, { status: "failed" })).toMatchObject({
      status: "failed",
      conversationId: null,
    });
    expect(updateRecord(completed.record.id, { status: "completed" }, {
      now,
      randomCode: () => "ABC123",
    })).toMatchObject({
      status: "completed",
      conversationId: `${completed.job.platformCode}20260923ABC123`,
      conversationIdAssignedAt: "2026-09-22T16:00:00.000Z",
    });
    expect(updateRecord(needsReview.record.id, { status: "needs_review" }, {
      now,
      randomCode: () => "DEF456",
    })).toMatchObject({
      status: "needs_review",
      conversationId: `${needsReview.job.platformCode}20260923DEF456`,
    });
  });

  it("keeps the first conversation ID through retries and status round-trips", () => {
    const { record } = createConversationRecord(`CIDSTABLE${Date.now()}`);
    const first = updateRecord(record.id, { status: "completed" }, {
      now: () => new Date("2026-09-22T04:00:00.000Z"),
      randomCode: () => "STABL1",
    });

    updateRecord(record.id, { status: "failed" });
    const reused = updateRecord(record.id, { status: "needs_review" }, {
      now: () => new Date("2027-01-01T00:00:00.000Z"),
      randomCode: () => "CHANGD",
    });

    expect(reused.conversationId).toBe(first.conversationId);
    expect(reused.conversationIdAssignedAt).toBe(first.conversationIdAssignedAt);
  });

  it("rolls back a final status when a historical task still lacks a platform", () => {
    const { record } = createConversationRecord();

    expect(() => updateRecord(record.id, { status: "completed" }, {
      randomCode: () => "ABC123",
    })).toThrow("历史任务缺少平台，请先补录平台");
    expect(getRecord(record.id)).toMatchObject({
      status: "pending",
      conversationId: null,
      conversationIdAssignedAt: null,
    });
  });

  it("rolls back the final status when collision retries are exhausted", () => {
    const platformCode = `CIDCOLLIDE${Date.now()}`;
    const first = createConversationRecord(platformCode);
    const secondPlatform = listPlatforms().find((item) => item.code === platformCode)!;
    conversationFixtureSequence += 1;
    const secondJob = createJob(
      `conversation-${conversationFixtureSequence}.xlsx`,
      `conversation-${conversationFixtureSequence}.xlsx`,
      undefined,
      secondPlatform,
    );
    addRecords(secondJob.id, [{
      sheetName: "Sheet1",
      rowNumber: 2,
      anchor: {},
      sourceFields: {},
      imagePath: "collision.png",
    }]);
    const secondRecord = listRecords(secondJob.id)[0];
    const now = () => new Date("2026-09-22T04:00:00.000Z");
    updateRecord(first.record.id, { status: "completed" }, {
      now,
      randomCode: () => "COLLID",
    });

    expect(() => updateRecord(secondRecord.id, { status: "completed" }, {
      now,
      randomCode: () => "COLLID",
      maxAttempts: 2,
    })).toThrow("会话 ID 生成失败：随机码碰撞次数超过上限");
    expect(getRecord(secondRecord.id)).toMatchObject({
      status: "pending",
      conversationId: null,
    });
  });

  it("rejects a disabled platform for new bound tasks", () => {
    const platform = createPlatform({ name: "停用平台", code: `DISABLED_${Date.now()}` });
    disablePlatform(platform.id);
    expect(() => createJob("disabled-platform.xlsx", "disabled-platform.xlsx", { id: "refund", name: "退货分析" }, platform))
      .toThrow("平台已停用");
  });

  it("deletes a job and its database records", () => {
    const job = createJob("delete-me.xlsx", "delete-me.xlsx");
    deleteJob(job.id);
    expect(getJob(job.id)).toBeUndefined();
  });

  it("rejects analysis with a different bound section", () => {
    const job = createJob("bound.xlsx", "bound.xlsx", { id: "refund", name: "退货分析" });
    expect(() => assertJobSection(job.id, "reception")).toThrow("任务已绑定解析板块：退货分析");
    expect(() => assertJobSection(job.id, "refund")).not.toThrow();
  });

  it("binds the current section version at job creation and preserves old bindings", () => {
    const sectionId = "job-version-binding";
    upsertSection({ id: sectionId, name: "任务版本绑定", prompt: "V1" });
    const initialDraft = createDraftVersion(sectionId);
    const initialPublished = publishSectionVersion(initialDraft.id);
    const first = createJob("version-1.xlsx", "version-1.xlsx", { id: sectionId, name: "任务版本绑定" });
    expect(first.sectionConfigVersionId).toBe(initialPublished.id);

    const draft = createDraftVersion(sectionId);
    const published = publishSectionVersion(draft.id);
    const second = createJob("version-2.xlsx", "version-2.xlsx", { id: sectionId, name: "任务版本绑定" });

    expect(published.isCurrent).toBe(true);
    expect(second.sectionConfigVersionId).toBe(published.id);
    updateJobSection(first.id, { id: sectionId, name: "任务版本绑定" });
    expect(getJob(first.id)?.sectionConfigVersionId).toBe(first.sectionConfigVersionId);
  });

  it("rejects section-bound jobs when no published current version exists", () => {
    const sectionId = "job-version-required";
    upsertSection({ id: sectionId, name: "缺少版本", prompt: "" });
    expect(() => createJob("missing-version.xlsx", "missing-version.xlsx", {
      id: sectionId,
      name: "缺少版本",
    })).toThrow("没有当前启用的已发布配置版本");
  });

  it("can bind a legacy unbound job on first analysis", () => {
    const job = createJob("legacy.xlsx", "legacy.xlsx");
    expect(() => assertJobSection(job.id, "refund")).not.toThrow();
    updateJobSection(job.id, { id: "refund", name: "退货分析" });
    expect(getJob(job.id)).toMatchObject({ sectionId: "refund", sectionName: "退货分析" });
  });

  it("guards a job against duplicate runs and supports control requests", () => {
    const job = createJob("controlled.xlsx", "controlled.xlsx");
    expect(acquireJobRun(job.id)).toBe(true);
    expect(acquireJobRun(job.id)).toBe(false);
    expect(requestJobPause(job.id)).toMatchObject({ status: "paused" });
    expect(requestJobCancel(job.id)).toMatchObject({ status: "cancelled" });
    releaseJobRun(job.id, "cancelled");
  });

  it("counts real run locks even after a job is paused or cancelled", () => {
    recoverStaleJobRuns();
    const baseline = countActiveJobRuns();
    const pausedJob = createJob("locked-paused.xlsx", "locked-paused.xlsx");
    const cancelledJob = createJob("locked-cancelled.xlsx", "locked-cancelled.xlsx");

    expect(acquireJobRun(pausedJob.id)).toBe(true);
    expect(acquireJobRun(cancelledJob.id)).toBe(true);
    requestJobPause(pausedJob.id);
    requestJobCancel(cancelledJob.id);

    expect(countActiveJobRuns()).toBe(baseline + 2);

    releaseJobRun(pausedJob.id, "paused");
    releaseJobRun(cancelledJob.id, "cancelled");
    expect(countActiveJobRuns()).toBe(baseline);
  });

  it("recovers stale run locks at process startup without leaving false active jobs", () => {
    recoverStaleJobRuns();
    const processingJob = createJob("stale-processing.xlsx", "stale-processing.xlsx");
    const pausedJob = createJob("stale-paused.xlsx", "stale-paused.xlsx");
    expect(acquireJobRun(processingJob.id)).toBe(true);
    expect(acquireJobRun(pausedJob.id)).toBe(true);
    requestJobPause(pausedJob.id);
    db.prepare("UPDATE jobs SET updated_at = datetime('now', '-20 minutes') WHERE id IN (?, ?)").run(processingJob.id, pausedJob.id);
    expect(countActiveJobRuns()).toBe(2);

    recoverStaleJobRuns();

    expect(countActiveJobRuns()).toBe(0);
    expect(getJob(processingJob.id)?.status).toBe("failed");
    expect(getJob(pausedJob.id)?.status).toBe("paused");
  });

  it("stores review results independently for each section", () => {
    const job = createJob("reviews.xlsx", "reviews.xlsx", { id: "refund", name: "退货分析" });
    addRecords(job.id, [{
      sheetName: "Sheet1",
      rowNumber: 2,
      anchor: {},
      sourceFields: {},
      imagePath: "reviews.png",
    }]);
    const record = db.prepare("SELECT id FROM records WHERE job_id = ?").get(job.id) as { id: string };
    updateRecord(record.id, {
      sectionId: "refund",
      humanResult: { reason: "工厂问题" },
      reviewStatus: "confirmed",
      reviewNote: "退货复核",
    });
    updateRecord(record.id, {
      sectionId: "reception",
      humanResult: { conclusion: "需改进" },
      reviewStatus: "confirmed",
      reviewNote: "接待复核",
    });
    expect(getRecord(record.id)?.sectionReviews).toMatchObject({
      refund: { humanResult: { reason: "工厂问题" }, reviewNote: "退货复核" },
      reception: { humanResult: { conclusion: "需改进" }, reviewNote: "接待复核" },
    });
    expect(getRecord(record.id)?.humanResult).toBeNull();
  });
  it("rejects review confirmation while a batch still owns the task", () => {
    const job = createJob("busy-review.xlsx", "busy-review.xlsx", { id: "refund", name: "refund" });
    addRecords(job.id, [{ sheetName: "s", rowNumber: 1, anchor: {}, sourceFields: {}, imagePath: "test.png" }]);
    const record = listRecords(job.id)[0];
    acquireJobRun(job.id);
    expect(() => updateRecord(record.id, { sectionId: "refund", status: "completed", reviewStatus: "confirmed" })).toThrow("正在解析");
    expect(getRecord(record.id)?.sectionReviews).toEqual({});
    releaseJobRun(job.id, "paused");
  });

  it("updates bound record status and task counts on review without changing other section reviews", () => {
    const platform = createPlatform({ name: "复核状态平台", code: "REVIEWSTATUS" });
    const job = createJob("review-status.xlsx", "review-status.xlsx", { id: "refund", name: "退款分析" }, platform);
    addRecords(job.id, [{ sheetName: "Sheet1", rowNumber: 2, anchor: {}, sourceFields: {}, imagePath: "test.png" }]);
    const record = db.prepare("SELECT id FROM records WHERE job_id=?").get(job.id);
    updateRecord(record.id, { status: "failed", reviewStatus: "needs_review" });
    const saved = updateRecord(record.id, { sectionId: "refund", status: "completed", reviewStatus: "confirmed", humanResult: { reason: "已复核" }, reviewNote: "确认" });
    expect(saved).toMatchObject({ status: "completed", reviewStatus: "confirmed", sectionReviews: { refund: { reviewStatus: "confirmed", reviewNote: "确认" } } });
    expect(getJob(job.id)).toMatchObject({ completedRecords: 1, failedRecords: 0 });
    expect(listRecordsPage(job.id, { status: "failed" }).total).toBe(0);
    updateRecord(record.id, { sectionId: "reception", status: "failed", reviewStatus: "needs_review", humanResult: { conclusion: "其他板块" } });
    expect(getRecord(record.id)).toMatchObject({ status: "completed", reviewStatus: "confirmed" });
    expect(getJob(job.id)?.completedRecords).toBe(1);
  });

  it("persists import progress and claims an import only once", () => {
    const importJob = createImportJob({
      filename: "large.xlsx",
      sourcePath: "large.xlsx",
      totalImages: 6000,
    });
    expect(importJob.status).toBe("queued");
    expect(claimImportJob(importJob.id)).toBe(true);
    expect(claimImportJob(importJob.id)).toBe(false);
    expect(updateImportJob(importJob.id, {
      processedImages: 120,
      processedRecords: 118,
      currentSheet: "Sheet1",
      currentRow: 121,
    })).toMatchObject({
      status: "processing",
      processedImages: 120,
      processedRecords: 118,
      currentSheet: "Sheet1",
      currentRow: 121,
    });
    expect(updateImportJob(importJob.id, {
      status: "failed",
      errorMessage: "测试失败",
    })).toMatchObject({ status: "failed", errorMessage: "测试失败" });
    expect(getImportJob(importJob.id)?.errorMessage).toBe("测试失败");
  });

  it("returns a stable paginated record page", () => {
    const job = createJob("paged.xlsx", "paged.xlsx");
    addRecords(job.id, Array.from({ length: 120 }, (_, index) => ({
      sheetName: "Sheet1",
      rowNumber: index + 1,
      anchor: {},
      sourceFields: { 序号: String(index + 1) },
      imagePath: `paged-${index + 1}.png`,
    })));

    const page = listRecordsPage(job.id, { page: 2, pageSize: 50 });

    expect(page.items).toHaveLength(50);
    expect(page.items[0].rowNumber).toBe(51);
    expect(page.total).toBe(120);
    expect(page.page).toBe(2);
    expect(page.pageSize).toBe(50);
  });

  it("uses the default page size and clamps the maximum page size", () => {
    const job = createJob("page-size.xlsx", "page-size.xlsx");
    addRecords(job.id, Array.from({ length: 205 }, (_, index) => ({
      sheetName: "Sheet1",
      rowNumber: index + 1,
      anchor: {},
      sourceFields: {},
      imagePath: `page-size-${index + 1}.png`,
    })));

    expect(listRecordsPage(job.id).items).toHaveLength(50);
    expect(listRecordsPage(job.id).pageSize).toBe(50);
    expect(listRecordsPage(job.id, { pageSize: 500 }).items).toHaveLength(200);
    expect(listRecordsPage(job.id, { pageSize: 500 }).pageSize).toBe(200);
  });

  it("normalizes invalid page values without producing an unsafe offset", () => {
    const job = createJob("invalid-page.xlsx", "invalid-page.xlsx");
    addRecords(job.id, [{
      sheetName: "Sheet1",
      rowNumber: 1,
      anchor: {},
      sourceFields: {},
      imagePath: "invalid-page.png",
    }]);

    for (const pageValue of [-10, Number.NaN, Number.POSITIVE_INFINITY, 1e20]) {
      const page = listRecordsPage(job.id, { page: pageValue, pageSize: 1 });
      expect(page.page).toBe(1);
      expect(page.items[0]?.rowNumber).toBe(1);
    }
  });

  it("falls back from non-finite or unsafe page sizes", () => {
    const job = createJob("invalid-page-size.xlsx", "invalid-page-size.xlsx");
    addRecords(job.id, Array.from({ length: 60 }, (_, index) => ({
      sheetName: "Sheet1",
      rowNumber: index + 1,
      anchor: {},
      sourceFields: {},
      imagePath: `invalid-page-size-${index + 1}.png`,
    })));

    for (const pageSizeValue of [Number.NaN, Number.POSITIVE_INFINITY, 1e20]) {
      const page = listRecordsPage(job.id, { pageSize: pageSizeValue });
      expect(page.pageSize).toBe(50);
      expect(page.items).toHaveLength(50);
    }
  });

  it("keeps listRecords compatible for full export reads", () => {
    const job = createJob("compatible-list.xlsx", "compatible-list.xlsx");
    addRecords(job.id, Array.from({ length: 55 }, (_, index) => ({
      sheetName: "Sheet1",
      rowNumber: index + 1,
      anchor: {},
      sourceFields: {},
      imagePath: `compatible-list-${index + 1}.png`,
    })));

    const records = listRecords(job.id);

    expect(records).toHaveLength(55);
    expect(records[0].rowNumber).toBe(1);
    expect(records[54].rowNumber).toBe(55);
  });

  it("filters record pages by analysis or review status", () => {
    const platform = createPlatform({ name: "状态筛选平台", code: "STATUSFILTER" });
    const job = createJob("status-filter.xlsx", "status-filter.xlsx", undefined, platform);
    addRecords(job.id, [
      { sheetName: "Sheet1", rowNumber: 1, anchor: {}, sourceFields: {}, imagePath: "completed.png" },
      { sheetName: "Sheet1", rowNumber: 2, anchor: {}, sourceFields: {}, imagePath: "review.png" },
      { sheetName: "Sheet1", rowNumber: 3, anchor: {}, sourceFields: {}, imagePath: "pending.png" },
    ]);
    const records = db.prepare("SELECT id, row_number FROM records WHERE job_id = ?").all(job.id) as Array<{
      id: string;
      row_number: number;
    }>;
    const completed = records.find((record) => record.row_number === 1)!;
    const needsReview = records.find((record) => record.row_number === 2)!;
    updateRecord(completed.id, { status: "completed" });
    updateRecord(needsReview.id, { reviewStatus: "needs_review" });

    const completedPage = listRecordsPage(job.id, { status: "completed" });
    const needsReviewPage = listRecordsPage(job.id, { status: "needs_review" });

    expect(completedPage.items.map((record) => record.rowNumber)).toEqual([1]);
    expect(completedPage.total).toBe(1);
    expect(needsReviewPage.items.map((record) => record.rowNumber)).toEqual([2]);
    expect(needsReviewPage.total).toBe(1);
  });

  it("loads only the next ordered batch of eligible record IDs", () => {
    const platform = createPlatform({ name: "批次候选平台", code: "BATCHCANDIDATES" });
    const job = createJob("batch-candidates.xlsx", "batch-candidates.xlsx", undefined, platform);
    addRecords(job.id, Array.from({ length: 6 }, (_, index) => ({
      sheetName: "Sheet1",
      rowNumber: index + 1,
      anchor: {},
      sourceFields: {},
      imagePath: `batch-candidate-${index + 1}.png`,
    })));
    const records = listRecords(job.id);
    updateRecord(records[0].id, { status: "completed" });
    updateRecord(records[1].id, { status: "failed" });
    updateRecord(records[2].id, { status: "needs_review" });
    updateRecord(records[3].id, { status: "processing" });

    const firstBatch = listBatchRecordIds(
      job.id,
      2,
      ["pending", "failed", "needs_review"],
    );
    const secondBatch = listBatchRecordIds(
      job.id,
      2,
      ["pending", "failed", "needs_review"],
      firstBatch.at(-1),
    );

    expect(firstBatch).toEqual([records[1].id, records[2].id]);
    expect(secondBatch).toEqual([records[4].id, records[5].id]);
  });

  it("returns a RecordPage from the records API and parses its query parameters", async () => {
    const platform = createPlatform({ name: "记录接口平台", code: "RECORDSAPI" });
    const job = createJob("records-api.xlsx", "records-api.xlsx", undefined, platform);
    addRecords(job.id, Array.from({ length: 6 }, (_, index) => ({
      sheetName: "Sheet1",
      rowNumber: index + 1,
      anchor: {},
      sourceFields: {},
      imagePath: `records-api-${index + 1}.png`,
    })));
    const rows = db.prepare("SELECT id, row_number FROM records WHERE job_id = ?").all(job.id) as Array<{
      id: string;
      row_number: number;
    }>;
    for (const row of rows.slice(0, 4)) updateRecord(row.id, { status: "completed" });
    const server: Server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;

    try {
      const { loginAdmin } = await import("../auth/test-admin");
      const cookie = await loginAdmin(`http://127.0.0.1:${address.port}`);
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/jobs/${job.id}/records?page=2&pageSize=2&status=completed`,
        { headers: { cookie } },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        success: true,
        data: {
          items: [
            expect.objectContaining({ rowNumber: 3, status: "completed" }),
            expect.objectContaining({ rowNumber: 4, status: "completed" }),
          ],
          total: 4,
          page: 2,
          pageSize: 2,
        },
        error: null,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("migrates knowledge tables and preserves legacy field defaults", () => {
    const tables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type IN ('table', 'view') AND name LIKE 'knowledge_%'
    `).all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining([
      "knowledge_bases",
      "knowledge_imports",
      "knowledge_items",
      "knowledge_match_snapshots",
      "knowledge_item_fts",
    ]));
    expect(db.prepare("PRAGMA table_info(knowledge_items)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "values_json" }),
        expect.objectContaining({ name: "path_key" }),
        expect.objectContaining({ name: "search_text" }),
      ]),
    );
    expect(db.prepare("PRAGMA table_info(knowledge_item_fts)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "item_id" }),
        expect.objectContaining({ name: "knowledge_base_id" }),
        expect.objectContaining({ name: "search_text" }),
      ]),
    );

    const fieldColumns = db.prepare("PRAGMA table_info(analysis_fields)").all() as Array<{
      name: string;
      dflt_value: string | number | null;
    }>;
    expect(fieldColumns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "execution_type", dflt_value: "'ai'" }),
      expect.objectContaining({ name: "export_enabled", dflt_value: "1" }),
      expect.objectContaining({ name: "knowledge_base_id", dflt_value: null }),
      expect.objectContaining({ name: "candidate_limit", dflt_value: "15" }),
      expect.objectContaining({ name: "match_field_key", dflt_value: null }),
      expect.objectContaining({ name: "knowledge_column", dflt_value: null }),
    ]));
    expect(db.prepare(`
      SELECT execution_type, export_enabled, candidate_limit
      FROM analysis_fields
      WHERE id = 'legacy-reception-conclusion'
    `).get()).toEqual({
      execution_type: "ai",
      export_enabled: 0,
      candidate_limit: 15,
    });
  });
});
