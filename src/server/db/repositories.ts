import { assertRunOwnership, assertRecordOwnership, currentRunToken } from "../services/run-ownership";
import { cancelAnalysis } from "../services/analysis-cancellation";
import crypto from "node:crypto";
import { sectionInput, parseConfiguration } from "../security/configuration-input";
import { db } from "./client";
import type { AnalysisSection, ImportJob, Job, RecordDetail, RecordSummary, RecordPage, RecordPageQuery, AnalysisRun, ModelConfig, ImportJobStatus, RecordStatus } from "../../shared/types";
import { listFieldRuns } from "../services/field-run-service";

const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value ?? {});
function mapImportJob(row: any): ImportJob {
  return {
    id: row.id,
    filename: row.filename,
    sourcePath: row.source_path,
    jobId: row.job_id ?? null,
    sectionId: row.section_id ?? null,
    sectionName: row.section_name ?? null,
    status: row.status,
    totalImages: row.total_images ?? 0,
    processedImages: row.processed_images ?? 0,
    failedImages: row.failed_images ?? 0,
    totalRecords: row.total_records ?? 0,
    processedRecords: row.processed_records ?? 0,
    currentSheet: row.current_sheet ?? null,
    currentRow: row.current_row ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSections(): AnalysisSection[] {
  return (db.prepare("SELECT * FROM analysis_sections ORDER BY sort_order").all() as any[]).map((row) => ({
    id: row.id, parentId: row.parent_id, name: row.name, prompt: row.prompt,
    outputSchema: JSON.parse(row.output_schema_json), sourceFields: JSON.parse(row.source_fields_json || "[]"), sortOrder: row.sort_order, isEnabled: Boolean(row.is_enabled),
    imageEnabled: row.image_enabled === undefined ? true : Boolean(row.image_enabled),
  }));
}
export function getSection(id: string) { return listSections().find((section) => section.id === id); }
export function mergeSectionSourceFields(sectionId: string, headers: string[]) {
  const section = getSection(sectionId);
  if (!section) return;
  const merged = [...new Set([...(section.sourceFields ?? []), ...headers.map((header) => header.trim()).filter(Boolean)])];
  db.prepare("UPDATE analysis_sections SET source_fields_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(merged), now(), sectionId);
}
  export function upsertSection(input: Partial<AnalysisSection> & { name: string; prompt: string }) {
    input = parseConfiguration(sectionInput, input);
    const seen = new Set(input.id ? [input.id] : []);
    let parentId = input.parentId;
    while (parentId) {
      if (seen.has(parentId)) throw new Error("板块父子关系存在循环");
      const parent = getSection(parentId);
      if (!parent) throw new Error("父板块不存在");
      seen.add(parentId); parentId = parent.parentId;
    }
    if (!input || typeof input.name !== "string" || input.name.trim().length < 1 || input.name.length > 120) throw new Error("板块名称长度必须为 1-120 个字符");
    if (typeof input.prompt !== "string" || input.prompt.length > 20_000) throw new Error("板块提示词过长或格式无效");
    if (input.parentId !== undefined && input.parentId !== null && typeof input.parentId !== "string") throw new Error("父板块 ID 无效");
    if (input.sourceFields !== undefined && (!Array.isArray(input.sourceFields) || input.sourceFields.length > 100 || input.sourceFields.some(value => typeof value !== "string" || value.length > 120))) throw new Error("来源字段格式无效或数量过多");
    if (input.outputSchema !== undefined && (!Array.isArray(input.outputSchema) || input.outputSchema.length > 200)) throw new Error("输出字段数量超过限制");
    if (input.sortOrder !== undefined && (!Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 100_000)) throw new Error("板块排序值无效");
  const id = input.id ?? crypto.randomUUID(), timestamp = now();
  const enabled = input.isEnabled ?? getSection(id)?.isEnabled ?? true;
  db.prepare(`INSERT INTO analysis_sections (id,parent_id,name,prompt,output_schema_json,source_fields_json,sort_order,is_enabled,image_enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,prompt=excluded.prompt,
    output_schema_json=excluded.output_schema_json,source_fields_json=excluded.source_fields_json,sort_order=excluded.sort_order,is_enabled=excluded.is_enabled,
    image_enabled=excluded.image_enabled,updated_at=excluded.updated_at`)
    .run(id, input.parentId ?? null, input.name, input.prompt, json(input.outputSchema ?? []), json(input.sourceFields ?? []), input.sortOrder ?? 0, enabled ? 1 : 0, input.imageEnabled === false ? 0 : 1, timestamp, timestamp);
  return getSection(id);
}
export function deleteSection(id: string) { db.prepare("DELETE FROM analysis_sections WHERE id = ?").run(id); }

export function createJob(filename: string, sourcePath: string, section?: { id: string; name: string }): Job {
  const id = crypto.randomUUID(), timestamp = now();
  const versionId = section
    ? (db.prepare(`
        SELECT id FROM analysis_section_versions
        WHERE section_id = ? AND status = 'published' AND is_current = 1
      `).get(section.id) as { id: string } | undefined)?.id ?? null
    : null;
  db.prepare(`INSERT INTO jobs
    (id,original_filename,source_path,section_id,section_name,section_config_version_id,status,total_records,completed_records,failed_records,created_at,updated_at)
    VALUES (?,?,?,?,?,?, 'ready',0,0,0,?,?)`).run(
    id,
    filename,
    sourcePath,
    section?.id ?? null,
    section?.name ?? null,
    versionId,
    timestamp,
    timestamp,
  );
  return getJob(id)!;
}
export function createImportJob(input: { filename: string; sourcePath: string; totalImages?: number; totalRecords?: number; jobId?: string; sectionId?: string; sectionName?: string }): ImportJob {
  const id = crypto.randomUUID();
  const timestamp = now();
  db.prepare(`INSERT INTO import_jobs
    (id, filename, source_path, job_id, section_id, section_name, status, total_images, total_records, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(
    id, input.filename, input.sourcePath, input.jobId ?? null,
    input.sectionId ?? null, input.sectionName ?? null,
    input.totalImages ?? 0, input.totalRecords ?? 0, timestamp, timestamp,
  );
  return getImportJob(id)!;
}
export function getImportJob(id: string): ImportJob | undefined {
  const row = db.prepare("SELECT * FROM import_jobs WHERE id = ?").get(id) as any;
  return row ? mapImportJob(row) : undefined;
}
export function claimImportJob(id: string): boolean {
  const result = db.prepare("UPDATE import_jobs SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'queued'").run(now(), id);
  return result.changes === 1;
}
export function updateImportJob(id: string, input: Partial<Pick<ImportJob, "status" | "jobId" | "sectionId" | "sectionName" | "sourcePath" | "totalImages" | "processedImages" | "failedImages" | "totalRecords" | "processedRecords" | "currentSheet" | "currentRow" | "errorMessage">>) {
  const current = getImportJob(id);
  if (!current) throw new Error("导入任务不存在");
  const next = { ...current, ...input };
  db.prepare(`UPDATE import_jobs SET source_path = ?, job_id = ?, section_id = ?, section_name = ?, status = ?, total_images = ?, processed_images = ?,
    failed_images = ?, total_records = ?, processed_records = ?, current_sheet = ?, current_row = ?,
    error_message = ?, updated_at = ? WHERE id = ?`).run(
    next.sourcePath, next.jobId, next.sectionId, next.sectionName, next.status, next.totalImages, next.processedImages, next.failedImages,
    next.totalRecords, next.processedRecords, next.currentSheet, next.currentRow, next.errorMessage, now(), id,
  );
  return getImportJob(id)!;
}
export function listImportJobs(status?: ImportJobStatus) {
  const rows = db.prepare(`SELECT * FROM import_jobs ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC`).all(...(status ? [status] : [])) as any[];
  return rows.map(mapImportJob);
}
function liveJobCounts(jobId: string, sectionId: string | null) {
  const p = getAnalysisProgressBaseline(jobId, sectionId ?? "");
  const fieldCount = db.prepare("SELECT COUNT(*) n FROM analysis_fields WHERE section_id=? AND is_enabled=1").get(sectionId ?? "").n as number;
  return { totalRecords: p.total, completedRecords: p.completed, failedRecords: p.failed,
    totalFields: p.total * fieldCount,
    pendingRecords: p.pending, processingRecords: p.processing, needsReviewRecords: p.needsReview,
    completedFields: p.completedFields, failedFields: p.failedFields, skippedFields: p.skippedFields,
    needsReviewFields: p.needsReviewFields };
}
export function getJob(id: string): Job | undefined {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as any;
  return row && {
    id: row.id,
    originalFilename: row.original_filename,
    sectionId: row.section_id ?? null,
    sectionName: row.section_name ?? null,
    sectionConfigVersionId: row.section_config_version_id ?? null,
    status: row.status,
    createdAt: row.created_at,
    cancelRequested: Boolean(row.cancel_requested),
    ...liveJobCounts(row.id, row.section_id),
  };
}
export function deleteJob(id: string) {
  const result = db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  if (!result.changes) throw new Error("任务不存在");
}
export function listJobs() {
  return (db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all() as any[]).map((row) => ({
    id: row.id,
    originalFilename: row.original_filename,
    sectionId: row.section_id ?? null,
    sectionName: row.section_name ?? null,
    sectionConfigVersionId: row.section_config_version_id ?? null,
    status: row.status,
    createdAt: row.created_at,
    cancelRequested: Boolean(row.cancel_requested),
    ...liveJobCounts(row.id, row.section_id),
  }));
}
export function countActiveJobRuns(): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE run_token IS NOT NULL").get() as { count: number }).count;
}
/** Only call after acquiring exclusive application ownership at process startup. */
export function recoverStaleJobRuns(): number {
  return db.transaction(() => {
    const affected = db.prepare("SELECT id,section_id FROM jobs WHERE run_token IS NOT NULL OR status='processing' OR id IN (SELECT job_id FROM records WHERE status='processing')").all() as { id: string; section_id: string | null }[];
    db.prepare("UPDATE records SET status='failed', review_status='needs_review',updated_at=? WHERE status='processing'").run(now());
    for (const job of affected) {
      const progress = getAnalysisProgressBaseline(job.id, job.section_id ?? "");
      db.prepare(`UPDATE jobs SET run_token=NULL,run_finished_at=?,
        status=CASE WHEN status='processing' THEN 'failed' ELSE status END,
        completed_records=?,failed_records=?,completed_fields=?,failed_fields=?,skipped_fields=?,updated_at=? WHERE id=?`)
        .run(Date.now(), progress.completed, progress.failed, progress.completedFields, progress.failedFields, progress.skippedFields, now(), job.id);
    }
    return affected.length;
  })();
}
export function getJobRunToken(jobId: string): string | undefined {
  return db.prepare("SELECT run_token FROM jobs WHERE id=?").get(jobId)?.run_token ?? undefined;
}
export function touchJobRun(jobId: string, token: string) {
  return db.prepare("UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND run_token = ?").run(Date.now(), jobId, token).changes === 1;
}
export function updateJobSection(jobId: string, section: { id: string; name: string }) {
  assertRunOwnership(jobId);
  const versionId = (db.prepare(`
    SELECT id FROM analysis_section_versions
    WHERE section_id = ? AND status = 'published' AND is_current = 1
  `).get(section.id) as { id: string } | undefined)?.id ?? null;
  db.prepare("UPDATE jobs SET section_id = ?, section_name = ?, section_config_version_id = ?, updated_at = ? WHERE id = ?")
    .run(section.id, section.name, versionId, now(), jobId);
}
export function updateJobSourcePath(jobId: string, sourcePath: string) {
  db.prepare("UPDATE jobs SET source_path = ?, updated_at = ? WHERE id = ?").run(sourcePath, now(), jobId);
}
export function acquireJobRun(jobId: string): boolean {
  const result = db.prepare(`UPDATE jobs SET run_token = ?, cancel_requested = 0, status = 'processing', updated_at = ?,run_started_at=?,heartbeat_at=?,run_finished_at=NULL
    WHERE id = ? AND run_token IS NULL AND status IN ('ready', 'failed', 'paused', 'cancelled', 'completed')`).run(crypto.randomUUID(), now(), Date.now(), Date.now(), jobId);
  return result.changes === 1;
}
export function releaseJobRun(jobId: string, status: Job["status"], token = currentRunToken(jobId) ?? getJobRunToken(jobId)) {
  if (token) db.prepare("UPDATE jobs SET run_token = NULL, status = ?, updated_at = ?,run_finished_at=? WHERE id = ? AND run_token=?").run(status, now(), Date.now(), jobId, token);
  return getJob(jobId);
}
export function requestJobPause(jobId: string) {
  db.prepare("UPDATE jobs SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'processing'").run(now(), jobId);
  return getJob(jobId);
}
export function requestJobCancel(jobId: string) {
  db.prepare("UPDATE jobs SET status = 'cancelled', cancel_requested = 1, updated_at = ? WHERE id = ? AND status IN ('ready', 'processing', 'paused')").run(now(), jobId);
  const job = getJob(jobId);
  if (job?.cancelRequested) cancelAnalysis(jobId, getJobRunToken(jobId));
  return job;
}
export function settleCancelledRecord(recordId: string, jobId: string, token: string) {
  db.prepare(`UPDATE records SET status='pending',review_status='pending',updated_at=?
    WHERE id=? AND job_id=? AND status='processing'
    AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND run_token=? AND cancel_requested=1)`)
    .run(now(), recordId, jobId, jobId, token);
}
export function resetFailedRecords(jobId: string) {
  const ids = (db.prepare("SELECT id FROM records WHERE job_id = ? AND status = 'failed'").all(jobId) as Array<{ id: string }>).map((row) => row.id);
  if (ids.length) {
    db.prepare(`UPDATE records SET status = 'pending', review_status = 'pending', updated_at = ?
      WHERE job_id = ? AND status = 'failed'`).run(now(), jobId);
  }
  return ids;
}
export function restoreFailedRecords(jobId: string, recordIds: string[]) {
  if (!recordIds.length) return;
  const placeholders = recordIds.map(() => "?").join(",");
  db.prepare(`UPDATE records
    SET status = 'failed', review_status = 'needs_review', updated_at = ?
    WHERE job_id = ? AND id IN (${placeholders}) AND status = 'pending'`)
    .run(now(), jobId, ...recordIds);
}
export function assertJobSection(jobId: string, sectionId: string) {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");
  if (job.sectionId && job.sectionId !== sectionId) {
    throw new Error(`任务已绑定解析板块：${job.sectionName ?? job.sectionId}`);
  }
  if (!job.sectionId) {
    const section = getSection(sectionId);
    if (!section || !section.isEnabled) throw new Error("解析板块不存在或未启用");
    updateJobSection(jobId, { id: section.id, name: section.name });
  }
}
export function updateJobProgress(jobId: string, input: { status: Job["status"]; completedRecords: number; failedRecords: number; totalFields?: number; completedFields?: number; failedFields?: number; skippedFields?: number }) {
  assertRunOwnership(jobId);
  db.prepare(`UPDATE jobs SET status = ?, completed_records = ?, failed_records = ?,
    total_fields = COALESCE(?, total_fields), completed_fields = COALESCE(?, completed_fields),
    failed_fields = COALESCE(?, failed_fields), skipped_fields = COALESCE(?, skipped_fields), updated_at = ? WHERE id = ?`)
    .run(input.status, input.completedRecords, input.failedRecords, input.totalFields ?? null, input.completedFields ?? null, input.failedFields ?? null, input.skippedFields ?? null, now(), jobId);
  return getJob(jobId);
}
export function addRecords(jobId: string, records: Array<{ sheetName: string; rowNumber: number; anchor: unknown; sourceFields: Record<string, string>; imagePath: string }>) {
  const insert = db.prepare(`INSERT INTO records (id,job_id,sheet_name,row_number,anchor_json,source_fields_json,image_path,status,review_status,review_note,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'pending','pending','',?,?)`);
  const transaction = db.transaction(() => {
    for (const record of records) insert.run(crypto.randomUUID(), jobId, record.sheetName, record.rowNumber, json(record.anchor), json(record.sourceFields), record.imagePath, now(), now());
    db.prepare("UPDATE jobs SET total_records = ?, updated_at = ? WHERE id = ?").run(records.length, now(), jobId);
  });
  transaction();
}
function mapRecord(row: any): RecordSummary {
  return { id: row.id, rowNumber: row.row_number, sheetName: row.sheet_name, sourceFields: JSON.parse(row.source_fields_json), imageUrl: `/api/records/${row.id}/image`, status: row.status, reviewStatus: row.review_status };
}
export function listRecords(jobId: string): RecordSummary[] { return (db.prepare("SELECT * FROM records WHERE job_id = ? ORDER BY row_number").all(jobId) as any[]).map(mapRecord); }
export function listBatchRecordIds(
  jobId: string,
  limit: number,
  statuses: RecordStatus[],
  afterRecordId?: string,
): string[] {
  if (!statuses.length) return [];
  const safeLimit = normalizeSafeInteger(limit, 20, 1, 100);
  const placeholders = statuses.map(() => "?").join(",");
  const cursorClause = afterRecordId
    ? `AND (
        row_number > COALESCE((SELECT row_number FROM records WHERE id = ? AND job_id = ?), -1)
        OR (
          row_number = COALESCE((SELECT row_number FROM records WHERE id = ? AND job_id = ?), -1)
          AND id > ?
        )
      )`
    : "";
  const cursorParams = afterRecordId
    ? [afterRecordId, jobId, afterRecordId, jobId, afterRecordId]
    : [];
  const rows = db.prepare(`SELECT id FROM records
    WHERE job_id = ? AND status IN (${placeholders}) ${cursorClause}
    ORDER BY row_number, id LIMIT ?`)
    .all(jobId, ...statuses, ...cursorParams, safeLimit) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}
export function getAnalysisProgressBaseline(jobId: string, sectionId: string) {
  const recordCounts = db.prepare(`SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) AS processing,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END), 0) AS needs_review
    FROM records
    WHERE job_id = ?`).get(jobId) as {
      total: number;
      pending: number;
      processing: number;
      completed: number;
      failed: number;
      needs_review: number;
    };
  const fieldCounts = db.prepare(`WITH latest_runs AS (
      SELECT afr.status,
        ROW_NUMBER() OVER (
          PARTITION BY afr.record_id, afr.field_id
          ORDER BY afr.created_at DESC, afr.rowid DESC
        ) AS rank
      FROM analysis_field_runs afr
      JOIN records r ON r.id = afr.record_id
      JOIN analysis_fields f ON f.id = afr.field_id
      WHERE r.job_id = ? AND f.section_id = ? AND f.is_enabled = 1
    )
    SELECT
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END), 0) AS skipped,
      COALESCE(SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END), 0) AS needs_review
    FROM latest_runs
    WHERE rank = 1`).get(jobId, sectionId) as {
      completed: number;
      failed: number;
      skipped: number;
      needs_review: number;
    };
  return {
    total: recordCounts.total,
    pending: recordCounts.pending,
    processing: recordCounts.processing,
    needsReviewFields: fieldCounts.needs_review,
    completed: recordCounts.completed,
    failed: recordCounts.failed,
    needsReview: recordCounts.needs_review,
    completedFields: fieldCounts.completed,
    failedFields: fieldCounts.failed,
    skippedFields: fieldCounts.skipped,
  };
}
function normalizeSafeInteger(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const integer = Math.floor(numeric);
  if (!Number.isSafeInteger(integer)) return fallback;
  return Math.min(max, Math.max(min, integer));
}
export function listRecordsPage(jobId: string, query: RecordPageQuery = {}): RecordPage {
  const pageSize = normalizeSafeInteger(query.pageSize, 50, 1, 200);
  let page = normalizeSafeInteger(query.page, 1, 1);
  let offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) {
    page = 1;
    offset = 0;
  }
  const status = query.status?.trim();
  const where = status
    ? "WHERE job_id = ? AND (status = ? OR review_status = ?)"
    : "WHERE job_id = ?";
  const params = status ? [jobId, status, status] : [jobId];
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM records ${where}`).get(...params) as { count: number }).count;
  const rows = db.prepare(`SELECT * FROM records ${where} ORDER BY row_number LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset) as any[];
  return { items: rows.map(mapRecord), total, page, pageSize };
}
export function getRecord(id: string): RecordDetail | undefined {
  const row = db.prepare("SELECT * FROM records WHERE id = ?").get(id) as any;
  if (!row) return;
  const runs = (db.prepare("SELECT * FROM analysis_runs WHERE record_id = ? ORDER BY created_at DESC").all(id) as any[]).map((run) => ({
    id: run.id, recordId: run.record_id, sectionId: run.section_id, status: run.status,
    result: JSON.parse(run.model_result_json), rawResponse: run.raw_response ?? undefined,
    errorMessage: run.error_message ?? undefined, createdAt: run.created_at,
  })) as AnalysisRun[];
  const sectionReviews = Object.fromEntries((db.prepare("SELECT * FROM record_section_reviews WHERE record_id = ?").all(id) as any[]).map((review) => [
    review.section_id,
    {
      humanResult: review.human_result_json ? JSON.parse(review.human_result_json) : null,
      reviewStatus: review.review_status,
      reviewNote: review.review_note ?? "",
    },
  ]));
  return { ...mapRecord(row), jobId: row.job_id, imagePath: row.image_path, humanResult: row.human_result_json ? JSON.parse(row.human_result_json) : null, reviewNote: row.review_note, sectionReviews, analysisRuns: runs, fieldRuns: listFieldRuns(id) };
}
export function updateRecord(id: string, input: { sectionId?: string; humanResult?: Record<string, unknown>; reviewStatus?: string; reviewNote?: string; status?: string }) {
  return db.transaction(() => {
  assertRecordOwnership(id);
  const row = getRecord(id);
  if (!row) throw new Error("记录不存在");
  if (input.sectionId && input.reviewStatus === "confirmed") {
    const running = db.prepare("SELECT run_token FROM jobs WHERE id = ?").get(row.jobId) as { run_token: string | null };
    if (running?.run_token || row.status === "processing") throw new Error("记录正在解析，请等待解析结束后保存复核");
  }
  if (input.sectionId) {
    db.prepare(`INSERT INTO record_section_reviews (record_id, section_id, human_result_json, review_status, review_note, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id, section_id) DO UPDATE SET human_result_json = excluded.human_result_json,
      review_status = excluded.review_status, review_note = excluded.review_note, updated_at = excluded.updated_at`)
      .run(id, input.sectionId, input.humanResult ? json(input.humanResult) : null, input.reviewStatus ?? "pending", input.reviewNote ?? "", now());
  }
  if (!input.sectionId) {
    db.prepare(`UPDATE records SET human_result_json = COALESCE(?, human_result_json), review_status = COALESCE(?, review_status),
      review_note = COALESCE(?, review_note), status = COALESCE(?, status), updated_at = ? WHERE id = ?`)
      .run(input.humanResult ? json(input.humanResult) : null, input.reviewStatus ?? null, input.reviewNote ?? null, input.status ?? null, now(), id);
  } else {
    const job = getJob(row.jobId);
    if (job?.sectionId === input.sectionId) {
      db.prepare("UPDATE records SET status = COALESCE(?, status), review_status = COALESCE(?, review_status), updated_at = ? WHERE id = ?")
        .run(input.status ?? null, input.reviewStatus ?? null, now(), id);
      db.prepare(`UPDATE jobs SET
        completed_records = (SELECT COUNT(*) FROM records WHERE job_id = ? AND status = 'completed'),
        failed_records = (SELECT COUNT(*) FROM records WHERE job_id = ? AND status = 'failed'),
        updated_at = ? WHERE id = ?`).run(row.jobId, row.jobId, now(), row.jobId);
    } else {
      db.prepare("UPDATE records SET updated_at = ? WHERE id = ?").run(now(), id);
    }
  }
  return getRecord(id)!;
  })();
}
export function createRun(input: { recordId: string; sectionId: string; modelSnapshot: unknown; prompt: string; schema: unknown; result: unknown; rawResponse?: string; errorMessage?: string; durationMs?: number; status: string; usage?: any }): AnalysisRun {
  assertRecordOwnership(input.recordId);
  const id = crypto.randomUUID(), timestamp = now();
  db.prepare(`INSERT INTO analysis_runs (id,record_id,section_id,model_config_snapshot_json,prompt_snapshot,output_schema_snapshot_json,model_result_json,raw_response,error_message,duration_ms,input_tokens,output_tokens,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.recordId, input.sectionId, json(input.modelSnapshot), input.prompt, json(input.schema), json(input.result), input.rawResponse ?? null, input.errorMessage ?? null, input.durationMs ?? null, input.usage?.prompt_tokens ?? null, input.usage?.completion_tokens ?? null, input.status, timestamp);
  return getRecord(input.recordId)!.analysisRuns[0];
}
