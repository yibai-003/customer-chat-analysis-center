import { createSafeUpload, validateXlsx, requireDiskSpace, UploadError } from "./security/upload-safety";
import { localAccess } from "./security/local-access";
import { projectRoot } from "./environment";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { config } from "./config";
import { initDb } from "./db/client";
import { startImportJob } from "./services/import-worker";
import { previewWorkbookStreaming } from "./services/streaming-xlsx-import-service";
import { listJobs, getJob, listRecordsPage, getRecord, updateRecord, listSections, upsertSection, deleteSection, requestJobPause, requestJobCancel, createImportJob, getImportJob, updateImportJob } from "./db/repositories";
import { analyzeRecord } from "./services/analysis-service";
import { analyzeJob, retryFailedJob } from "./services/batch-analysis-service";
import { exportJob } from "./services/excel-export-service";
import { createModelConfig, listModelConfigs, setDefaultModel, testModelConnection, testModelCapabilities, updateModelConfig, deleteModelConfig, getModelReadinessChecks, getModelReadinessActions } from "./services/model-config-service";
import { removeJob, removeJobs } from "./services/job-management-service";
import { listFields, upsertField, deleteField } from "./services/field-config-service";
import { analyzeField, retryField } from "./services/field-analysis-service";
import { normalizeUploadedFilename } from "./utils/encoding";
import { createKnowledgeRouter } from "./routes/knowledge-routes";
import { getAnalysisCapacity } from "./services/analysis-capacity-service";
import { initializeKnowledgeSync, type KnowledgeSync } from "./services/knowledge/knowledge-sync-service";
import { setHotTopicKnowledgeSync } from "./services/knowledge/hot-topic-service";
import { createModelPoolRouter } from "./routes/model-pool-router";

interface AppDependencies {
  knowledgeSync?: KnowledgeSync;
  analysisCapacityProvider?: typeof getAnalysisCapacity;
  analyzeJobRunner?: typeof analyzeJob;
  retryFailedJobStarter?: typeof retryFailedJob;
}

export function createApp(dependencies: AppDependencies = {}) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const knowledgeSync = dependencies.knowledgeSync ?? (process.env.NODE_ENV === "test" ? undefined : initializeKnowledgeSync());
  if (!knowledgeSync) initDb();
  setHotTopicKnowledgeSync(knowledgeSync);
  const app = express();
  app.use(localAccess);
  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    const configurationChange = ["POST", "PATCH", "DELETE"].includes(req.method)
      && (/^\/api\/(sections|fields|knowledge-bases|knowledge-items)(\/|$)/.test(req.path))
      && !req.path.endsWith("/import-preview") && !req.path.endsWith("/search-test");
    if (!knowledgeSync || !configurationChange) return next();
    try { knowledgeSync.assertUnchanged(); } catch (error) {
      return res.status(409).json({ success: false, data: null, error: (error as Error).message });
    }
    const sendJson = res.json.bind(res);
    res.json = (body: any) => {
      if (res.statusCode < 400 && body?.success === true) {
        try { knowledgeSync.export(); } catch { /* the DB save succeeded; durable status enables export-only retry */ }
        return sendJson({ ...body, sync: knowledgeSync.status() });
      }
      return sendJson(body);
    };
    next();
  });
  const upload = createSafeUpload();
  app.use((req, _res, next) => {
    if (req.method === "POST" && req.is("multipart/form-data")) {
      try { requireDiskSpace(); } catch (error) { return next(error); }
    }
    next();
  });
  const ok = (res: express.Response, data: unknown) => res.json({ success: true, data, error: null });
  const fail = (res: express.Response, error: unknown, status = 400) => res.status(error instanceof UploadError ? error.status : status).json({ success: false, data: null, error: error instanceof Error ? error.message : "请求失败" });
  app.get("/api/health", (_req, res) => {
    res.json({ success: true, data: { status: "ok" }, error: null });
  });
  app.get("/api/knowledge-sync", (_req, res) => {
    if (!knowledgeSync) return res.status(503).json({ success: false, data: null, error: "知识同步未初始化" });
    return ok(res, knowledgeSync.status());
  });
  app.post("/api/knowledge-sync/retry", (_req, res) => {
    if (!knowledgeSync) return res.status(503).json({ success: false, data: null, error: "知识同步未初始化" });
    try { knowledgeSync.export(); return ok(res, knowledgeSync.status()); }
    catch { return res.status(knowledgeSync.status().state === "conflict" ? 409 : 503).json({ success: false,
      data: knowledgeSync.status(), error: "本地数据仍已保存，快照暂未生成。请检查文件权限、磁盘空间或仓库冲突后重试。" }); }
  });
  app.get("/api/ready", (_req, res) => {
    try {
      const disk = fs.statfsSync(config.dataDir);
      const freeDiskMb = Math.floor(Number(disk.bavail) * Number(disk.bsize) / 1024 / 1024);
      const checks = getModelReadinessChecks();
      const vision = checks.vision.verified;
      const text = checks.text.verified;
      const ready = freeDiskMb >= config.minFreeDiskMb && vision && text;
      return res.status(ready ? 200 : 503).json({ success: ready, data: { ready, database: true, freeDiskMb, minFreeDiskMb: config.minFreeDiskMb, models: { vision, text }, modelChecks: checks, actions: getModelReadinessActions() }, error: ready ? null : "模型未检测、检测失败/过期，或磁盘空间不足" });
    } catch (error) { return fail(res, error, 503); }
  });
  app.get("/api/system/analysis-capacity", (_req, res) => {
    try {
      return ok(res, (dependencies.analysisCapacityProvider ?? getAnalysisCapacity)());
    } catch {
      return fail(res, new Error("系统容量指标暂时不可用"), 500);
    }
  });
  app.get("/api/jobs", (_req, res) => ok(res, listJobs()));
  app.get("/api/jobs/:id", (req, res) => { const job = getJob(req.params.id); return job ? ok(res, job) : fail(res, "任务不存在", 404); });
  app.get("/api/jobs/:id/records", (req, res) => ok(res, listRecordsPage(req.params.id, {
    page: Number(req.query.page),
    pageSize: Number(req.query.pageSize),
    status: typeof req.query.status === "string" ? req.query.status : undefined,
  })));
  app.delete("/api/jobs/:id", async (req, res) => { try { await removeJob(req.params.id); return ok(res, true); } catch (error) { return fail(res, error); } });
  app.delete("/api/jobs", async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown): id is string => typeof id === "string") : [];
      if (!ids.length) return fail(res, "请选择要删除的任务");
      return ok(res, await removeJobs(ids));
    } catch (error) { return fail(res, error); }
  });
  app.get("/api/records/:id", (req, res) => { const record = getRecord(req.params.id); return record ? ok(res, record) : fail(res, "记录不存在", 404); });
  app.post("/api/jobs/import", upload.single("file"), async (req, res) => {
    if (!req.file) {
      return fail(res, "请上传 .xlsx 文件");
    }
    let moved = false;
    try {
      await validateXlsx(req.file.path, req.file.originalname);
      const section = req.body.sectionId ? listSections().find((item) => item.id === req.body.sectionId && item.isEnabled) : undefined;
      if (req.body.sectionId && !section) return fail(res, "解析板块不存在或未启用");
      const importJob = createImportJob({
        filename: normalizeUploadedFilename(req.file.originalname),
        sourcePath: req.file.path,
        sectionId: section?.id,
        sectionName: section?.name,
      });
      const durableDir = path.join(config.dataDir, "imports", importJob.id);
      fs.mkdirSync(durableDir, { recursive: true });
      const durablePath = path.join(durableDir, "source.xlsx");
      fs.renameSync(req.file.path, durablePath);
      moved = true;
      updateImportJob(importJob.id, { sourcePath: durablePath });
      startImportJob(importJob.id);
      return ok(res, getImportJob(importJob.id));
    } catch (error) { return fail(res, error); }
    finally { if (req.file && !moved) fs.rmSync(req.file.path, { force: true }); }
  });
  app.get("/api/import-jobs/:id", (req, res) => {
    const job = getImportJob(req.params.id);
    return job ? ok(res, job) : fail(res, "导入任务不存在", 404);
  });
  app.post("/api/jobs/import-preview", upload.single("file"), async (req, res) => {
    if (!req.file) {
      return fail(res, "请上传 .xlsx 文件");
    }
    try {
      await validateXlsx(req.file.path, req.file.originalname);
      const section = req.body.sectionId ? listSections().find((item) => item.id === req.body.sectionId && item.isEnabled) : undefined;
      if (req.body.sectionId && !section) return fail(res, "解析板块不存在或未启用");
      return ok(res, await previewWorkbookStreaming(req.file.path, req.file.originalname, section && { id: section.id, name: section.name, sourceFields: section.sourceFields }));
    } catch (error) { return fail(res, error); }
    finally { if (req.file) fs.rmSync(req.file.path, { force: true }); }
  });
  app.get("/api/records/:id/image", (req, res) => {
    const record = getRecord(req.params.id);
    if (!record || !fs.existsSync(record.imagePath)) return res.status(404).end();
    return res.sendFile(path.resolve(record.imagePath));
  });
  app.post("/api/records/:id/analyze", async (req, res) => {
    try { return ok(res, await analyzeRecord(req.params.id, req.body.sectionId)); } catch (error) { return fail(res, error); }
  });
  app.post("/api/records/:id/analyze-field", async (req, res) => {
    try { return ok(res, await analyzeField(req.params.id, req.body.sectionId, req.body.fieldKey)); } catch (error) { return fail(res, error); }
  });
  app.post("/api/records/:id/retry-field", async (req, res) => {
    try { return ok(res, await retryField(req.params.id, req.body.sectionId, req.body.fieldKey)); } catch (error) { return fail(res, error); }
  });
  app.post("/api/records/:id/retry", async (req, res) => {
    try { return ok(res, await analyzeRecord(req.params.id, req.body.sectionId)); } catch (error) { return fail(res, error); }
  });
  app.patch("/api/records/:id", (req, res) => { try { return ok(res, updateRecord(req.params.id, req.body)); } catch (error) { return fail(res, error); } });
  app.post("/api/jobs/:id/analyze", async (req, res) => {
    try {
      if (!getJob(req.params.id)) return fail(res, "任务不存在", 404);
      void (dependencies.analyzeJobRunner ?? analyzeJob)(req.params.id, req.body.sectionId, {
        concurrency: req.body.concurrency,
        batchSize: req.body.batchSize,
        maxPaidTokens: req.body.maxPaidTokens,
      }).catch((error) => console.error("批量解析失败", error));
      return ok(res, getJob(req.params.id));
    } catch (error) { return fail(res, error); }
  });
  app.post("/api/jobs/:id/pause", (req, res) => {
    try { return ok(res, requestJobPause(req.params.id)); } catch (error) { return fail(res, error); }
  });
  app.post("/api/jobs/:id/cancel", (req, res) => {
    try { return ok(res, requestJobCancel(req.params.id)); } catch (error) { return fail(res, error); }
  });
  app.post("/api/jobs/:id/retry-failed", async (req, res) => {
    try {
      const started = await (dependencies.retryFailedJobStarter ?? retryFailedJob)(req.params.id);
      if (started) void started.completion.catch((error) => console.error("失败记录重试失败", error));
      return ok(res, getJob(req.params.id));
    } catch (error) { return fail(res, error); }
  });
  app.get("/api/jobs/:id/export", async (req, res) => {
    try {
      const ids = String(req.query.sections ?? "").split(",").filter(Boolean);
      const output = await exportJob(req.params.id, ids.length ? ids : listSections().filter((section) => section.parentId).map((section) => section.id));
      return res.download(output);
    } catch (error) { return fail(res, error); }
  });
  app.get("/api/sections", (_req, res) => ok(res, listSections()));
  app.get("/api/sections/:id/fields", (req, res) => ok(res, listFields(req.params.id)));
  app.post("/api/sections/:id/fields", (req, res) => { try { return ok(res, upsertField({ ...req.body, sectionId: req.params.id })); } catch (error) { return fail(res, error); } });
  app.patch("/api/fields/:id", (req, res) => { try { return ok(res, upsertField({ ...req.body, id: req.params.id, sectionId: req.body.sectionId })); } catch (error) { return fail(res, error); } });
  app.delete("/api/fields/:id", (req, res) => { try { deleteField(req.params.id); return ok(res, true); } catch (error) { return fail(res, error); } });
  app.post("/api/sections", (req, res) => { try { return ok(res, upsertSection(req.body)); } catch (error) { return fail(res, error); } });
  app.patch("/api/sections/:id", (req, res) => { try { return ok(res, upsertSection({ ...req.body, id: req.params.id })); } catch (error) { return fail(res, error); } });
  app.delete("/api/sections/:id", (req, res) => { deleteSection(req.params.id); return ok(res, true); });
  app.get("/api/model-configs", (_req, res) => ok(res, listModelConfigs()));
  app.post("/api/model-configs", (req, res) => { try { return ok(res, createModelConfig(req.body)); } catch (error) { return fail(res, error); } });
  app.patch("/api/model-configs/:id", (req, res) => { try { return ok(res, updateModelConfig(req.params.id, req.body)); } catch (error) { return fail(res, error); } });
  app.delete("/api/model-configs/:id", (req, res) => { try { deleteModelConfig(req.params.id); return ok(res, true); } catch (error) { return fail(res, error); } });
  app.post("/api/model-configs/:id/default", (req, res) => { try { return ok(res, setDefaultModel(req.params.id, req.body?.purpose)); } catch (error) { return fail(res, error); } });
  app.post("/api/model-configs/:id/test", async (req, res) => { try { return ok(res, await testModelConnection(req.params.id)); } catch (error) { return fail(res, error); } });
  app.post("/api/model-configs/:id/test-capabilities", async (req, res) => { try { return ok(res, await testModelCapabilities(req.params.id)); } catch (error) { return fail(res, error); } });
  app.use("/api", createKnowledgeRouter(upload));
  app.use("/api", createModelPoolRouter());
  app.use(express.static(path.join(projectRoot, "dist")));
  app.use((
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const parseError = error instanceof SyntaxError
      && typeof error === "object"
      && error !== null
      && "type" in error
      && error.type === "entity.parse.failed";
    const uploadError = error instanceof multer.MulterError;
    const fileTooLarge = uploadError && error.code === "LIMIT_FILE_SIZE";
    const status = error instanceof UploadError ? error.status : fileTooLarge ? 413 : parseError ? 400 : 500;
    const normalizedError = fileTooLarge
      ? new Error(`文件超过当前上限（${config.maxUploadMb} MB）。请调整 MAX_UPLOAD_MB，或使用拆分后的 Excel 文件。`)
      : parseError
        ? new Error("请求 JSON 格式无效")
        : error;
    return fail(
      res,
      normalizedError,
      status,
    );
  });
  return app;
}
