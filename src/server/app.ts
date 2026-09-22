import { createSafeUpload, validateXlsx, requireDiskSpace, UploadError } from "./security/upload-safety";
import { localAccess } from "./security/local-access";
import { projectRoot } from "./environment";
import { readRuntimeVersion, type RuntimeVersion } from "./runtime-version";
import { getReadinessStatus, type ReadinessStatus } from "./services/readiness-service";
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
import { analyzeJob, prepareTargetedRecordIds, retryFailedJob } from "./services/batch-analysis-service";
import { exportJob } from "./services/excel-export-service";
import { clearDefaultModel, createModelConfig, listModelConfigs, setDefaultModel, testModelConnection, testModelCapabilities, updateModelConfig, deleteModelConfig } from "./services/model-config-service";
import { removeJob, removeJobs } from "./services/job-management-service";
import { listFields, upsertField, deleteField } from "./services/field-config-service";
import { analyzeField, retryField } from "./services/field-analysis-service";
import { normalizeUploadedFilename } from "./utils/encoding";
import { createKnowledgeRouter } from "./routes/knowledge-routes";
import { getAnalysisCapacity } from "./services/analysis-capacity-service";
import { initializeKnowledgeSync, type KnowledgeSync } from "./services/knowledge/knowledge-sync-service";
import { setHotTopicKnowledgeSync } from "./services/knowledge/hot-topic-service";
import { createModelPoolRouter } from "./routes/model-pool-router";
import { createAdminRouter } from "./routes/admin-router";
import { createAuthRouter } from "./auth/auth-routes";
import { ensureInitialAdminBootstrap } from "./auth/bootstrap";
import { requireAuth } from "./auth/session-auth";
import { requireCapability } from "./auth/capabilities";
import { auditRequest } from "./auth/audit";
import { correlationId } from "./auth/correlation";
import {
  activateSectionVersion,
  archiveSectionVersion,
  createDraftVersion,
  deleteDraftSectionVersion,
  getSectionVersion,
  listSectionVersions,
  publishSectionVersion,
  restoreSectionVersion,
  updateDraftSectionVersion,
} from "./services/section-config-version-service";

interface AppDependencies {
  knowledgeSync?: KnowledgeSync;
  analysisCapacityProvider?: typeof getAnalysisCapacity;
  analyzeJobRunner?: typeof analyzeJob;
  retryFailedJobStarter?: typeof retryFailedJob;
  runtimeVersionProvider?: () => RuntimeVersion;
  readinessProvider?: () => ReadinessStatus;
}

export function createApp(dependencies: AppDependencies = {}) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const knowledgeSync = dependencies.knowledgeSync ?? (process.env.NODE_ENV === "test" ? undefined : initializeKnowledgeSync());
  if (!knowledgeSync) initDb();
  ensureInitialAdminBootstrap();
  setHotTopicKnowledgeSync(knowledgeSync);
  const app = express();
  app.use(correlationId);
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
  const canView = requireCapability("task:view", "task.view", "task");
  const canImport = requireCapability("task:import", "task.import", "task");
  const canAnalyzeJob = requireCapability("task:analyze", "task.start_analysis", "job");
  const canAnalyzeRecord = requireCapability("task:analyze", "task.analyze_record", "record");
  const canAnalyzeField = requireCapability("task:analyze", "task.analyze_field", "record");
  const canRetryField = requireCapability("task:analyze", "task.retry_field", "record");
  const canRetryRecord = requireCapability("task:analyze", "task.retry_record", "record");
  const canPause = requireCapability("task:analyze", "task.pause", "job");
  const canCancel = requireCapability("task:analyze", "task.cancel", "job");
  const canRetryFailed = requireCapability("task:analyze", "task.retry_failed", "job");
  const canCheckCapacity = requireCapability("task:analyze", "task.check_capacity", "system");
  const canDelete = requireCapability("task:delete", "task.delete", "task");
  const canExport = requireCapability("task:export", "task.export", "task");
  const canReview = requireCapability("review:save", "review.save", "record");
  const canManageConfig = requireCapability("config:manage", "config.manage", "configuration");
  const canManageSystem = requireCapability("admin:manage", "system.manage", "system");
  app.get("/api/health", (_req, res) => {
    res.json({ success: true, data: { status: "ok" }, error: null });
  });
  app.get("/api/version", (_req, res) => {
    return ok(res, (dependencies.runtimeVersionProvider ?? readRuntimeVersion)());
  });
  app.use("/api/auth", createAuthRouter());
  app.use("/api", requireAuth());
  app.use("/api/admin", createAdminRouter());
  app.get("/api/knowledge-sync", canView, (_req, res) => {
    if (!knowledgeSync) return res.status(503).json({ success: false, data: null, error: "知识同步未初始化" });
    return ok(res, knowledgeSync.status());
  });
  app.post("/api/knowledge-sync/retry", canManageConfig, (_req, res) => {
    if (!knowledgeSync) return res.status(503).json({ success: false, data: null, error: "知识同步未初始化" });
    try { knowledgeSync.export(); return ok(res, knowledgeSync.status()); }
    catch { return res.status(knowledgeSync.status().state === "conflict" ? 409 : 503).json({ success: false,
      data: knowledgeSync.status(), error: "本地数据仍已保存，快照暂未生成。请检查文件权限、磁盘空间或仓库冲突后重试。" }); }
  });
  app.get("/api/ready", canManageSystem, (_req, res) => {
    try {
      const status = (dependencies.readinessProvider ?? getReadinessStatus)();
      return res.status(status.ready ? 200 : 503).json({
        success: status.ready,
        data: status,
        error: status.ready ? null : "数据库未就绪、模型未检测/失败/过期，或磁盘空间不足",
      });
    } catch (error) { return fail(res, error, 503); }
  });
  app.get("/api/system/analysis-capacity", canCheckCapacity, (_req, res) => {
    try {
      return ok(res, (dependencies.analysisCapacityProvider ?? getAnalysisCapacity)());
    } catch {
      return fail(res, new Error("系统容量指标暂时不可用"), 500);
    }
  });
  app.get("/api/jobs", canView, (_req, res) => ok(res, listJobs()));
  app.get("/api/jobs/:id", canView, (req, res) => { const job = getJob(req.params.id); return job ? ok(res, job) : fail(res, "任务不存在", 404); });
  app.get("/api/jobs/:id/records", canView, (req, res) => ok(res, listRecordsPage(req.params.id, {
    page: Number(req.query.page),
    pageSize: Number(req.query.pageSize),
    status: typeof req.query.status === "string" ? req.query.status : undefined,
  })));
  app.delete("/api/jobs/:id", canDelete, async (req, res) => {
    try {
      await removeJob(req.params.id);
      auditRequest(req, { action: "task.delete", targetType: "job", targetId: req.params.id });
      return ok(res, true);
    } catch (error) { return fail(res, error); }
  });
  app.delete("/api/jobs", canDelete, async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown): id is string => typeof id === "string") : [];
      if (!ids.length) return fail(res, "请选择要删除的任务");
      const result = await removeJobs(ids);
      auditRequest(req, { action: "task.delete", targetType: "job", metadata: { count: ids.length } });
      return ok(res, result);
    } catch (error) { return fail(res, error); }
  });
  app.get("/api/records/:id", canView, (req, res) => { const record = getRecord(req.params.id); return record ? ok(res, record) : fail(res, "记录不存在", 404); });
  app.post("/api/jobs/import", canImport, upload.single("file"), async (req, res) => {
    if (!req.file) {
      return fail(res, "请上传 .xlsx 文件");
    }
    let moved = false;
    try {
      await validateXlsx(req.file.path, req.file.originalname);
      const filename = normalizeUploadedFilename(req.file.originalname);
      const section = req.body.sectionId ? listSections().find((item) => item.id === req.body.sectionId && item.isEnabled) : undefined;
      if (req.body.sectionId && !section) return fail(res, "解析板块不存在或未启用");
      const importJob = createImportJob({
        filename,
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
      auditRequest(req, { action: "task.import", targetType: "import_job", targetId: importJob.id, metadata: { filename, sectionId: section?.id ?? null } });
      return ok(res, getImportJob(importJob.id));
    } catch (error) { return fail(res, error); }
    finally { if (req.file && !moved) fs.rmSync(req.file.path, { force: true }); }
  });
  app.get("/api/import-jobs/:id", canImport, (req, res) => {
    const job = getImportJob(req.params.id);
    return job ? ok(res, job) : fail(res, "导入任务不存在", 404);
  });
  app.post("/api/jobs/import-preview", canImport, upload.single("file"), async (req, res) => {
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
  app.get("/api/records/:id/image", canView, (req, res) => {
    const record = getRecord(req.params.id);
    if (!record || !fs.existsSync(record.imagePath)) return res.status(404).end();
    return res.sendFile(path.resolve(record.imagePath));
  });
  app.post("/api/records/:id/analyze", canAnalyzeRecord, async (req, res) => {
    try {
      const result = await analyzeRecord(req.params.id, req.body.sectionId);
      auditRequest(req, { action: "task.analyze_record", targetType: "record", targetId: req.params.id, metadata: { sectionId: req.body.sectionId ?? null } });
      return ok(res, result);
    } catch (error) { return fail(res, error); }
  });
  app.post("/api/records/:id/analyze-field", canAnalyzeField, async (req, res) => {
    try {
      const result = await analyzeField(req.params.id, req.body.sectionId, req.body.fieldKey);
      auditRequest(req, { action: "task.analyze_field", targetType: "record", targetId: req.params.id, metadata: { sectionId: req.body.sectionId ?? null, fieldKey: req.body.fieldKey ?? null } });
      return ok(res, result);
    } catch (error) { return fail(res, error); }
  });
  app.post("/api/records/:id/retry-field", canRetryField, async (req, res) => {
    try {
      const result = await retryField(req.params.id, req.body.sectionId, req.body.fieldKey);
      auditRequest(req, { action: "task.retry_field", targetType: "record", targetId: req.params.id, metadata: { sectionId: req.body.sectionId ?? null, fieldKey: req.body.fieldKey ?? null } });
      return ok(res, result);
    } catch (error) { return fail(res, error); }
  });
  app.post("/api/records/:id/retry", canRetryRecord, async (req, res) => {
    try {
      const result = await analyzeRecord(req.params.id, req.body.sectionId);
      auditRequest(req, { action: "task.retry_record", targetType: "record", targetId: req.params.id, metadata: { sectionId: req.body.sectionId ?? null } });
      return ok(res, result);
    } catch (error) { return fail(res, error); }
  });
  app.patch("/api/records/:id", canReview, (req, res) => {
    try {
      const updated = updateRecord(req.params.id, req.body);
      auditRequest(req, {
        action: "review.save",
        targetType: "record",
        targetId: req.params.id,
        metadata: { sectionId: req.body?.sectionId ?? null, reviewStatus: req.body?.reviewStatus ?? null },
      });
      return ok(res, updated);
    } catch (error) { return fail(res, error); }
  });
  app.post("/api/jobs/:id/analyze", canAnalyzeJob, async (req, res) => {
    try {
      if (!getJob(req.params.id)) return fail(res, "任务不存在", 404);
      const targeted = req.body.recordIds !== undefined
        ? prepareTargetedRecordIds(req.params.id, req.body.recordIds)
        : undefined;
      if (!targeted || targeted.executable.length) {
        void (dependencies.analyzeJobRunner ?? analyzeJob)(req.params.id, req.body.sectionId, {
          concurrency: req.body.concurrency,
          batchSize: req.body.batchSize,
          maxPaidTokens: req.body.maxPaidTokens,
          recordIds: targeted?.executable,
        }).catch((error) => console.error("批量解析失败", error));
        auditRequest(req, {
          action: "task.start_analysis",
          targetType: "job",
          targetId: req.params.id,
          metadata: {
            sectionId: req.body.sectionId ?? null,
            selected: targeted?.selected ?? null,
            executable: targeted?.executable.length ?? null,
          },
        });
      }
      return ok(res, {
        ...getJob(req.params.id),
        targeted: targeted ? {
          selected: targeted.selected,
          executable: targeted.executable.length,
          skipped: targeted.skipped,
        } : undefined,
      });
    } catch (error) { return fail(res, error); }
  });
  app.post("/api/jobs/:id/pause", canPause, (req, res) => {
    try {
      const job = requestJobPause(req.params.id);
      auditRequest(req, { action: "task.pause", targetType: "job", targetId: req.params.id });
      return ok(res, job);
    } catch (error) { return fail(res, error); }
  });
  app.post("/api/jobs/:id/cancel", canCancel, (req, res) => {
    try {
      const job = requestJobCancel(req.params.id);
      auditRequest(req, { action: "task.cancel", targetType: "job", targetId: req.params.id });
      return ok(res, job);
    } catch (error) { return fail(res, error); }
  });
  app.post("/api/jobs/:id/retry-failed", canRetryFailed, async (req, res) => {
    try {
      const started = await (dependencies.retryFailedJobStarter ?? retryFailedJob)(req.params.id);
      if (started) {
        void started.completion.catch((error) => console.error("失败记录重试失败", error));
        auditRequest(req, { action: "task.retry_failed", targetType: "job", targetId: req.params.id });
      }
      return ok(res, getJob(req.params.id));
    } catch (error) { return fail(res, error); }
  });
  app.get("/api/jobs/:id/export", canExport, async (req, res) => {
    try {
      const ids = String(req.query.sections ?? "").split(",").filter(Boolean);
      const output = await exportJob(req.params.id, ids.length ? ids : listSections().filter((section) => section.parentId).map((section) => section.id));
      auditRequest(req, { action: "task.export", targetType: "job", targetId: req.params.id, metadata: { sections: ids } });
      return res.download(output);
    } catch (error) { return fail(res, error); }
  });
  app.get("/api/sections", canView, (_req, res) => ok(res, listSections()));
  app.get("/api/sections/:id/versions", canView, (req, res) => ok(res, listSectionVersions(req.params.id)));
  app.get("/api/section-config-versions/:id", canView, (req, res) => {
    const version = getSectionVersion(req.params.id);
    return version ? ok(res, version) : fail(res, "配置版本不存在", 404);
  });
  app.post("/api/sections/:id/versions", canManageConfig, (req, res) => {
    try {
      const version = createDraftVersion(req.params.id);
      auditRequest(req, {
        action: "config.version_create_draft",
        targetType: "section_config_version",
        targetId: version.id,
        metadata: { sectionId: version.sectionId, versionNumber: version.versionNumber },
      });
      return ok(res, version);
    } catch (error) { return fail(res, error); }
  });
  app.post("/api/section-config-versions/:id/publish", canManageConfig, (req, res) => {
    try {
      const version = publishSectionVersion(req.params.id);
      auditRequest(req, {
        action: "config.version_publish",
        targetType: "section_config_version",
        targetId: version.id,
        metadata: { sectionId: version.sectionId, versionNumber: version.versionNumber },
      });
      return ok(res, version);
    } catch (error) { return fail(res, error); }
  });
  app.patch("/api/section-config-versions/:id", canManageConfig, (req, res) => {
    try {
      const version = updateDraftSectionVersion(req.params.id, req.body ?? {});
      auditRequest(req, {
        action: "config.version_update_draft",
        targetType: "section_config_version",
        targetId: version.id,
        metadata: { sectionId: version.sectionId, versionNumber: version.versionNumber },
      });
      return ok(res, version);
    } catch (error) { return fail(res, error); }
  });
  app.delete("/api/section-config-versions/:id", canManageConfig, (req, res) => {
    try {
      const version = getSectionVersion(req.params.id);
      if (!version) return fail(res, "配置版本不存在", 404);
      deleteDraftSectionVersion(req.params.id);
      auditRequest(req, {
        action: "config.version_delete_draft",
        targetType: "section_config_version",
        targetId: req.params.id,
        metadata: { sectionId: version.sectionId, versionNumber: version.versionNumber },
      });
      return ok(res, true);
    } catch (error) { return fail(res, error); }
  });
  app.post("/api/section-config-versions/:id/archive", canManageConfig, (req, res) => {
    try {
      const version = archiveSectionVersion(req.params.id);
      auditRequest(req, {
        action: "config.version_archive",
        targetType: "section_config_version",
        targetId: version.id,
        metadata: { sectionId: version.sectionId, versionNumber: version.versionNumber },
      });
      return ok(res, version);
    } catch (error) { return fail(res, error); }
  });
  app.post("/api/section-config-versions/:id/restore", canManageConfig, (req, res) => {
    try {
      const version = restoreSectionVersion(req.params.id);
      auditRequest(req, {
        action: "config.version_restore",
        targetType: "section_config_version",
        targetId: version.id,
        metadata: { sectionId: version.sectionId, versionNumber: version.versionNumber },
      });
      return ok(res, version);
    } catch (error) { return fail(res, error); }
  });
  app.post("/api/section-config-versions/:id/activate", canManageConfig, (req, res) => {
    try {
      const version = activateSectionVersion(req.params.id);
      auditRequest(req, {
        action: "config.version_activate",
        targetType: "section_config_version",
        targetId: version.id,
        metadata: { sectionId: version.sectionId, versionNumber: version.versionNumber },
      });
      return ok(res, version);
    } catch (error) { return fail(res, error); }
  });
  app.get("/api/sections/:id/fields", canView, (req, res) => ok(res, listFields(req.params.id)));
  app.post("/api/sections/:id/fields", canManageConfig, (req, res) => {
    try {
      const field = upsertField({ ...req.body, sectionId: req.params.id });
      auditRequest(req, { action: "config.upsert_field", targetType: "field", targetId: field?.id, metadata: { sectionId: req.params.id, key: field?.key } });
      return ok(res, field);
    } catch (error) { return fail(res, error); }
  });
  app.patch("/api/fields/:id", canManageConfig, (req, res) => {
    try {
      const field = upsertField({ ...req.body, id: req.params.id, sectionId: req.body.sectionId });
      auditRequest(req, { action: "config.upsert_field", targetType: "field", targetId: req.params.id, metadata: { sectionId: req.body?.sectionId, key: field?.key } });
      return ok(res, field);
    } catch (error) { return fail(res, error); }
  });
  app.delete("/api/fields/:id", canManageConfig, (req, res) => {
    try {
      deleteField(req.params.id);
      auditRequest(req, { action: "config.delete_field", targetType: "field", targetId: req.params.id });
      return ok(res, true);
    } catch (error) { return fail(res, error); }
  });
  app.post("/api/sections", canManageConfig, (req, res) => {
    try {
      const section = upsertSection(req.body);
      auditRequest(req, { action: "config.upsert_section", targetType: "section", targetId: section?.id, metadata: { name: section?.name } });
      return ok(res, section);
    } catch (error) { return fail(res, error); }
  });
  app.patch("/api/sections/:id", canManageConfig, (req, res) => {
    try {
      const section = upsertSection({ ...req.body, id: req.params.id });
      auditRequest(req, { action: "config.upsert_section", targetType: "section", targetId: req.params.id, metadata: { name: section?.name } });
      return ok(res, section);
    } catch (error) { return fail(res, error); }
  });
  app.delete("/api/sections/:id", canManageConfig, (req, res) => {
    deleteSection(req.params.id);
    auditRequest(req, { action: "config.delete_section", targetType: "section", targetId: req.params.id });
    return ok(res, true);
  });
  app.get("/api/model-configs", canView, (_req, res) => ok(res, listModelConfigs()));
  app.post("/api/model-configs", canManageConfig, (req, res) => {
    try {
      const model = createModelConfig(req.body);
      auditRequest(req, { action: "config.create_model", targetType: "model_config", targetId: model.id, metadata: { name: model.name, purpose: model.purpose } });
      return ok(res, model);
    } catch (error) { return fail(res, error); }
  });
  app.patch("/api/model-configs/:id", canManageConfig, (req, res) => {
    try {
      const model = updateModelConfig(req.params.id, req.body);
      auditRequest(req, { action: "config.update_model", targetType: "model_config", targetId: req.params.id, metadata: { name: model.name, fields: Object.keys(req.body ?? {}) } });
      return ok(res, model);
    } catch (error) { return fail(res, error); }
  });
  app.delete("/api/model-configs/:id", canManageConfig, (req, res) => {
    try {
      deleteModelConfig(req.params.id);
      auditRequest(req, { action: "config.delete_model", targetType: "model_config", targetId: req.params.id });
      return ok(res, true);
    } catch (error) { return fail(res, error); }
  });
  app.delete("/api/model-configs/default/:purpose", canManageConfig, (req, res) => {
    try {
      const purpose = req.params.purpose;
      if (purpose !== "vision" && purpose !== "text") throw new Error("模型用途无效");
      clearDefaultModel(purpose);
      auditRequest(req, {
        action: "config.clear_default_model",
        targetType: "model_config",
        metadata: { purpose },
      });
      return ok(res, true);
    } catch (error) { return fail(res, error); }
  });
  app.post("/api/model-configs/:id/default", canManageConfig, (req, res) => {
    try {
      const model = setDefaultModel(req.params.id, req.body?.purpose);
      auditRequest(req, { action: "config.set_default_model", targetType: "model_config", targetId: req.params.id, metadata: { purpose: req.body?.purpose ?? null } });
      return ok(res, model);
    } catch (error) { return fail(res, error); }
  });
  app.post("/api/model-configs/:id/test", canManageConfig, async (req, res) => {
    try {
      const result = await testModelConnection(req.params.id);
      auditRequest(req, { action: "config.test_model", targetType: "model_config", targetId: req.params.id });
      return ok(res, result);
    } catch (error) { return fail(res, error); }
  });
  app.post("/api/model-configs/:id/test-capabilities", canManageConfig, async (req, res) => {
    try {
      const result = await testModelCapabilities(req.params.id);
      auditRequest(req, { action: "config.test_model_capabilities", targetType: "model_config", targetId: req.params.id });
      return ok(res, result);
    } catch (error) { return fail(res, error); }
  });
  app.use("/api", requireCapability("config:manage", "config.knowledge", "knowledge"), createKnowledgeRouter(upload));
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
