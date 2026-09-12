import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import { config } from "../config";
import { normalizeUploadedFilename } from "../utils/encoding";
import {
  importKnowledgeWorkbook,
  previewKnowledgeImport,
} from "../services/knowledge/knowledge-import-service";
import {
  deleteKnowledgeBase,
  deleteKnowledgeItem,
  getKnowledgeBase,
  getKnowledgeItem,
  listKnowledgeBases,
  listKnowledgeItems,
  upsertKnowledgeBase,
  upsertKnowledgeItem,
} from "../services/knowledge/knowledge-repository";
import { searchKnowledge } from "../services/knowledge/knowledge-search-service";
import type { KnowledgeColumn } from "../../shared/types";

const PREVIEW_TTL_MS = 30 * 60 * 1000;

interface PendingPreview {
  sectionId: string;
  knowledgeBaseId?: string;
  filePath: string;
  originalFilename: string;
  cleanupTimer: NodeJS.Timeout;
}

function removeFile(filePath: string | undefined): void {
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Cleanup is best-effort; the API result should still reflect the main operation.
  }
}

function isXlsxFile(filePath: string | undefined): boolean {
  if (!filePath) return false;
  try {
    const signature = fs.readFileSync(filePath).subarray(0, 4);
    return signature.length === 4 && signature[0] === 0x50 && signature[1] === 0x4b
      && (signature[2] === 0x03 || signature[2] === 0x05 || signature[2] === 0x07);
  } catch { return false; }
}

function parseColumns(value: unknown): KnowledgeColumn[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return value as KnowledgeColumn[];
  if (typeof value !== "string") throw new Error("列映射格式无效");
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("列映射格式无效");
  return parsed as KnowledgeColumn[];
}

function normalizePreviewColumns(
  headers: string[],
  configured?: KnowledgeColumn[],
): KnowledgeColumn[] {
  const configuredByName = new Map(
    (configured ?? []).map((column) => [
      column.name.trim(),
      { ...column, name: column.name.trim() },
    ]),
  );
  return headers.map((header) => configuredByName.get(header) ?? {
    name: header,
    roles: configured ? ["metadata"] : ["result", "search"],
  });
}

function sameColumns(left: KnowledgeColumn[], right: KnowledgeColumn[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveKnowledgeBaseId(
  sectionId: string,
  headers: string[],
  configuredColumns: KnowledgeColumn[] | undefined,
  requestedKnowledgeBaseId: string | undefined,
): string | undefined {
  if (requestedKnowledgeBaseId) return requestedKnowledgeBaseId;
  const previewColumns = normalizePreviewColumns(headers, configuredColumns);
  const matches = listKnowledgeBases(sectionId).filter(
    (base) => sameColumns(base.columns, previewColumns),
  );
  return matches.length === 1 ? matches[0].id : undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

function parseEnabled(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error("enabled 参数必须是 true 或 false");
}

function cleanupPreviewDirectory(previewDirectory: string): void {
  fs.mkdirSync(previewDirectory, { recursive: true });
  for (const entry of fs.readdirSync(previewDirectory, { withFileTypes: true })) {
    if (entry.isFile() || entry.isSymbolicLink()) {
      removeFile(path.join(previewDirectory, entry.name));
    }
  }
}

export function createKnowledgeRouter(upload: multer.Multer): express.Router {
  const router = express.Router();
  const pendingPreviews = new Map<string, PendingPreview>();
  const previewDirectory = path.join(config.dataDir, "knowledge-previews");
  const importDirectory = path.join(config.dataDir, "knowledge-imports");
  cleanupPreviewDirectory(previewDirectory);

  const ok = (res: express.Response, data: unknown) => (
    res.json({ success: true, data, error: null })
  );
  const fail = (res: express.Response, error: unknown, status = 400) => (
    res.status(status).json({
      success: false,
      data: null,
      error: error instanceof Error ? error.message : String(error || "请求失败"),
    })
  );

  router.get("/sections/:sectionId/knowledge-bases", (req, res) => {
    return ok(res, listKnowledgeBases(req.params.sectionId));
  });

  router.post(
    "/sections/:sectionId/knowledge-bases/import-preview",
    upload.single("file"),
    async (req, res) => {
      const uploadedPath = req.file?.path;
      if (!req.file || !req.file.originalname.toLowerCase().endsWith(".xlsx") || !isXlsxFile(req.file.path)) {
        removeFile(uploadedPath);
        return fail(res, "请上传 .xlsx 文件");
      }

      const token = crypto.randomUUID();
      const sectionId = Array.isArray(req.params.sectionId)
        ? req.params.sectionId[0]
        : req.params.sectionId;
      const originalFilename = normalizeUploadedFilename(req.file.originalname);
      const stagedPath = path.join(previewDirectory, `${token}.xlsx`);
      try {
        fs.mkdirSync(previewDirectory, { recursive: true });
        fs.renameSync(req.file.path, stagedPath);
        const columns = parseColumns(req.body.columns);
        const knowledgeBaseId = req.body.knowledgeBaseId || undefined;
        const preview = await previewKnowledgeImport(
          stagedPath,
          originalFilename,
          sectionId,
          columns,
          knowledgeBaseId,
        );
        const resolvedKnowledgeBaseId = resolveKnowledgeBaseId(
          sectionId,
          preview.headers,
          columns,
          knowledgeBaseId,
        );
        const cleanupTimer = setTimeout(() => {
          const pending = pendingPreviews.get(token);
          if (!pending) return;
          pendingPreviews.delete(token);
          removeFile(pending.filePath);
        }, PREVIEW_TTL_MS);
        cleanupTimer.unref();
        pendingPreviews.set(token, {
          sectionId,
          knowledgeBaseId: resolvedKnowledgeBaseId,
          filePath: stagedPath,
          originalFilename,
          cleanupTimer,
        });
        return ok(res, {
          ...preview,
          token,
          resolvedKnowledgeBaseId: resolvedKnowledgeBaseId ?? null,
        });
      } catch (error) {
        removeFile(stagedPath);
        removeFile(uploadedPath);
        return fail(res, error);
      }
    },
  );

  router.post(
    "/sections/:sectionId/knowledge-bases/import",
    async (req, res) => {
      const token = typeof req.body?.token === "string" ? req.body.token : "";
      const pending = pendingPreviews.get(token);
      if (!pending) return fail(res, "预览令牌无效或已失效");
      if (pending.sectionId !== req.params.sectionId) {
        return fail(res, "预览令牌不属于当前板块");
      }
      if (
        req.body.knowledgeBaseId !== undefined
        && req.body.knowledgeBaseId !== pending.knowledgeBaseId
      ) {
        return fail(res, "预览令牌与知识库不匹配");
      }

      pendingPreviews.delete(token);
      clearTimeout(pending.cleanupTimer);
      let persistedPath: string | undefined;
      let completed = false;
      try {
        fs.mkdirSync(importDirectory, { recursive: true });
        persistedPath = path.join(importDirectory, `${crypto.randomUUID()}.xlsx`);
        fs.renameSync(pending.filePath, persistedPath);
        const result = await importKnowledgeWorkbook({
          filePath: persistedPath,
          originalFilename: pending.originalFilename,
          sectionId: pending.sectionId,
          name: req.body.name,
          columns: parseColumns(req.body.columns),
          knowledgeBaseId: pending.knowledgeBaseId,
        });
        completed = true;
        return ok(res, result);
      } catch (error) {
        return fail(res, error);
      } finally {
        if (!completed) {
          removeFile(pending.filePath);
          removeFile(persistedPath);
        }
      }
    },
  );

  router.patch("/knowledge-bases/:id", (req, res) => {
    try {
      const existing = getKnowledgeBase(req.params.id);
      if (!existing) return fail(res, "知识库不存在", 404);
      return ok(res, upsertKnowledgeBase({
        id: existing.id,
        sectionId: existing.sectionId,
        name: req.body.name ?? existing.name,
        originalFilename: existing.originalFilename,
        columns: existing.columns,
        isEnabled: req.body.isEnabled ?? existing.isEnabled,
      }));
    } catch (error) {
      return fail(res, error);
    }
  });

  router.delete("/knowledge-bases/:id", (req, res) => {
    try {
      if (!getKnowledgeBase(req.params.id)) return fail(res, "知识库不存在", 404);
      deleteKnowledgeBase(req.params.id);
      return ok(res, true);
    } catch (error) {
      return fail(res, error);
    }
  });

  router.get("/knowledge-bases/:id/items", (req, res) => {
    try {
      if (!getKnowledgeBase(req.params.id)) return fail(res, "知识库不存在", 404);
      return ok(res, listKnowledgeItems(req.params.id, {
        search: typeof req.query.search === "string" ? req.query.search : undefined,
        enabled: parseEnabled(req.query.enabled),
        page: parsePositiveInteger(req.query.page),
        pageSize: parsePositiveInteger(req.query.pageSize),
      }));
    } catch (error) {
      return fail(res, error);
    }
  });

  router.post("/knowledge-bases/:id/items", (req, res) => {
    try {
      if (!getKnowledgeBase(req.params.id)) return fail(res, "知识库不存在", 404);
      return ok(res, upsertKnowledgeItem({
        knowledgeBaseId: req.params.id,
        values: req.body.values ?? {},
        isEnabled: req.body.isEnabled ?? true,
      }));
    } catch (error) {
      return fail(res, error);
    }
  });

  router.patch("/knowledge-items/:id", (req, res) => {
    try {
      const existing = getKnowledgeItem(req.params.id);
      if (!existing) return fail(res, "知识条目不存在", 404);
      return ok(res, upsertKnowledgeItem({
        id: existing.id,
        knowledgeBaseId: existing.knowledgeBaseId,
        values: req.body.values
          ? { ...existing.values, ...req.body.values }
          : existing.values,
        isEnabled: req.body.isEnabled ?? existing.isEnabled,
        sourceRowNumber: existing.sourceRowNumber,
      }));
    } catch (error) {
      return fail(res, error);
    }
  });

  router.delete("/knowledge-items/:id", (req, res) => {
    try {
      if (!getKnowledgeItem(req.params.id)) return fail(res, "知识条目不存在", 404);
      deleteKnowledgeItem(req.params.id);
      return ok(res, true);
    } catch (error) {
      return fail(res, error);
    }
  });

  router.post("/knowledge-bases/:id/search-test", (req, res) => {
    try {
      if (!getKnowledgeBase(req.params.id)) return fail(res, "知识库不存在", 404);
      return ok(res, searchKnowledge({
        knowledgeBaseId: req.params.id,
        query: typeof req.body.query === "string" ? req.body.query : "",
        limit: parsePositiveInteger(req.body.limit),
      }));
    } catch (error) {
      return fail(res, error);
    }
  });

  router.use((
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => fail(res, error instanceof multer.MulterError ? error.message : error));

  return router;
}
