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
} from "./repositories";

describe("job repository", () => {
  beforeAll(() => initDb());

  it("creates a job with matching SQL columns and values", () => {
    const job = createJob("sample.xlsx", "sample.xlsx");
    expect(job.originalFilename).toBe("sample.xlsx");
    expect(job.status).toBe("ready");
    expect(job.sectionName).toBeNull();
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
    const job = createJob("status-filter.xlsx", "status-filter.xlsx");
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
    const job = createJob("batch-candidates.xlsx", "batch-candidates.xlsx");
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
    const job = createJob("records-api.xlsx", "records-api.xlsx");
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
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/jobs/${job.id}/records?page=2&pageSize=2&status=completed`,
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
      export_enabled: 1,
      candidate_limit: 15,
    });
  });
});
