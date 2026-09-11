import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import multer from "multer";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { config } from "../config";
import { db, initDb } from "../db/client";
import { createKnowledgeRouter } from "./knowledge-routes";
import {
  getKnowledgeBase,
  listKnowledgeItems,
  upsertKnowledgeBase,
  upsertKnowledgeItem,
} from "../services/knowledge/knowledge-repository";
import { createKnowledgeWorkbook } from "../services/knowledge/knowledge-test-fixtures";
import type { KnowledgeColumn } from "../../shared/types";

const sectionId = "refund";
const columns: KnowledgeColumn[] = [
  { name: "一级原因", roles: ["result", "search"] },
  { name: "二级原因", roles: ["result", "keyword"] },
  { name: "说明", roles: ["description"] },
];

let server: Server;
let baseUrl: string;
let startupResidualPath: string;

function clearKnowledgeData() {
  db.exec(`
    DELETE FROM knowledge_item_fts;
    DELETE FROM knowledge_imports;
    DELETE FROM knowledge_items;
    DELETE FROM knowledge_bases;
  `);
}

async function jsonRequest(
  pathname: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: init?.body instanceof FormData
      ? init.headers
      : { "content-type": "application/json", ...init?.headers },
  });
  return { status: response.status, body: await response.json() };
}

async function uploadPreview(
  targetSectionId: string,
  filePath: string,
  extra: Record<string, string> = {},
) {
  const form = new FormData();
  form.set("file", new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return jsonRequest(
    `/api/sections/${targetSectionId}/knowledge-bases/import-preview`,
    { method: "POST", body: form },
  );
}

function createBase(name = "退货原因") {
  return upsertKnowledgeBase({
    sectionId,
    name,
    originalFilename: "seed.xlsx",
    columns,
    isEnabled: true,
  });
}

beforeAll(async () => {
  initDb();
  const previewDirectory = path.join(config.dataDir, "knowledge-previews");
  fs.mkdirSync(previewDirectory, { recursive: true });
  startupResidualPath = path.join(previewDirectory, "restart-residual.xlsx");
  fs.writeFileSync(startupResidualPath, "residual");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => clearKnowledgeData());

afterAll(async () => {
  clearKnowledgeData();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

describe("knowledge API routes", () => {
  it("removes preview files left behind before the application starts", () => {
    expect(fs.existsSync(startupResidualPath)).toBe(false);
  });

  it("lists section knowledge bases with the shared response envelope", async () => {
    const base = createBase();

    const response = await jsonRequest(`/api/sections/${sectionId}/knowledge-bases`);

    expect(response).toEqual({
      status: 200,
      body: { success: true, data: [base], error: null },
    });
  });

  it("previews an upload, binds its token to the section, imports once, and persists the source file", async () => {
    const workbookPath = await createKnowledgeWorkbook({
      headers: columns.map((column) => column.name),
      rows: [["商品问题", "破损", "外包装破损"]],
    });
    const uploadDirectory = path.join(config.dataDir, "uploads");
    const uploadsBefore = fs.existsSync(uploadDirectory)
      ? new Set(fs.readdirSync(uploadDirectory))
      : new Set<string>();

    const preview = await uploadPreview(sectionId, workbookPath, {
      columns: JSON.stringify(columns),
    });

    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      success: true,
      data: {
        headers: ["一级原因", "二级原因", "说明"],
        totalRows: 1,
        added: 1,
      },
      error: null,
    });
    expect(preview.body.data.token).toEqual(expect.any(String));
    const uploadsAfter = fs.existsSync(uploadDirectory)
      ? fs.readdirSync(uploadDirectory)
      : [];
    expect(uploadsAfter.filter((name) => !uploadsBefore.has(name))).toEqual([]);

    const wrongSection = await jsonRequest(
      "/api/sections/product/knowledge-bases/import",
      {
        method: "POST",
        body: JSON.stringify({
          token: preview.body.data.token,
          name: "退货原因",
          columns,
        }),
      },
    );
    expect(wrongSection).toEqual({
      status: 400,
      body: { success: false, data: null, error: "预览令牌不属于当前板块" },
    });

    const confirmed = await jsonRequest(
      `/api/sections/${sectionId}/knowledge-bases/import`,
      {
        method: "POST",
        body: JSON.stringify({
          token: preview.body.data.token,
          name: "退货原因",
          columns,
        }),
      },
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      success: true,
      data: { added: 1, updated: 0, skipped: 0 },
      error: null,
    });
    const importRow = db.prepare(`
      SELECT source_path
      FROM knowledge_imports
      WHERE knowledge_base_id = ?
    `).get(confirmed.body.data.knowledgeBase.id) as { source_path: string };
    expect(fs.existsSync(importRow.source_path)).toBe(true);
    expect(path.resolve(importRow.source_path).startsWith(path.resolve(config.dataDir)))
      .toBe(true);

    const replay = await jsonRequest(
      `/api/sections/${sectionId}/knowledge-bases/import`,
      {
        method: "POST",
        body: JSON.stringify({
          token: preview.body.data.token,
          name: "退货原因",
          columns,
        }),
      },
    );
    expect(replay).toEqual({
      status: 400,
      body: { success: false, data: null, error: "预览令牌无效或已失效" },
    });
  });

  it("binds an automatically resolved preview to the unique existing knowledge base", async () => {
    const base = createBase();
    upsertKnowledgeItem({
      knowledgeBaseId: base.id,
      values: { 一级原因: "商品问题", 二级原因: "破损", 说明: "旧说明" },
      isEnabled: true,
    });
    const workbookPath = await createKnowledgeWorkbook({
      headers: columns.map((column) => column.name),
      rows: [["商品问题", "破损", "新说明"]],
    });

    const preview = await uploadPreview(sectionId, workbookPath, {
      columns: JSON.stringify(columns),
    });

    expect(preview.body).toMatchObject({
      success: true,
      data: {
        resolvedKnowledgeBaseId: base.id,
        added: 0,
        updated: 1,
      },
      error: null,
    });

    const confirmed = await jsonRequest(
      `/api/sections/${sectionId}/knowledge-bases/import`,
      {
        method: "POST",
        body: JSON.stringify({
          token: preview.body.data.token,
          columns,
        }),
      },
    );
    expect(confirmed.body.data.knowledgeBase.id).toBe(base.id);
    expect(getKnowledgeBase(base.id)?.itemCount).toBe(1);
    expect(listKnowledgeItems(base.id).items[0].values["说明"]).toBe("新说明");
    expect((await jsonRequest(`/api/sections/${sectionId}/knowledge-bases`)).body.data)
      .toHaveLength(1);
  });

  it("keeps prior knowledge unchanged and removes the moved source when confirmed import fails", async () => {
    const base = createBase();
    const item = upsertKnowledgeItem({
      knowledgeBaseId: base.id,
      values: { 一级原因: "商品问题", 二级原因: "破损", 说明: "旧说明" },
      isEnabled: true,
    });
    const workbookPath = await createKnowledgeWorkbook({
      headers: columns.map((column) => column.name),
      rows: [["商品问题", "破损", "新说明"]],
    });
    const preview = await uploadPreview(sectionId, workbookPath, {
      knowledgeBaseId: base.id,
      columns: JSON.stringify(columns),
    });
    expect(preview.status).toBe(200);
    const importDirectory = path.join(config.dataDir, "knowledge-imports");
    const filesBefore = fs.existsSync(importDirectory)
      ? new Set(fs.readdirSync(importDirectory))
      : new Set<string>();
    db.exec(`
      CREATE TEMP TRIGGER fail_route_knowledge_import
      BEFORE INSERT ON knowledge_imports
      BEGIN
        SELECT RAISE(ABORT, 'route import failed');
      END;
    `);

    let response;
    try {
      response = await jsonRequest(
        `/api/sections/${sectionId}/knowledge-bases/import`,
        {
          method: "POST",
          body: JSON.stringify({
            token: preview.body.data.token,
            knowledgeBaseId: base.id,
            columns,
          }),
        },
      );
    } finally {
      db.exec("DROP TRIGGER fail_route_knowledge_import");
    }

    expect(response).toEqual({
      status: 400,
      body: { success: false, data: null, error: "route import failed" },
    });
    expect(listKnowledgeItems(base.id).items).toEqual([item]);
    const filesAfter = fs.existsSync(importDirectory)
      ? fs.readdirSync(importDirectory)
      : [];
    expect(filesAfter.filter((name) => !filesBefore.has(name))).toEqual([]);

    const replay = await jsonRequest(
      `/api/sections/${sectionId}/knowledge-bases/import`,
      {
        method: "POST",
        body: JSON.stringify({
          token: preview.body.data.token,
          knowledgeBaseId: base.id,
          columns,
        }),
      },
    );
    expect(replay.body).toEqual({
      success: false,
      data: null,
      error: "预览令牌无效或已失效",
    });
  });

  it("removes the staged preview when confirmation fails before the file move", async () => {
    const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-route-"));
    const originalDataDir = config.dataDir;
    config.dataDir = isolatedDataDir;
    const isolatedApp = express();
    isolatedApp.use(express.json());
    const isolatedUpload = multer({ dest: path.join(isolatedDataDir, "uploads") });
    isolatedApp.use("/api", createKnowledgeRouter(isolatedUpload));
    const isolatedServer = isolatedApp.listen(0);
    await new Promise<void>((resolve) => isolatedServer.once("listening", resolve));
    const address = isolatedServer.address() as AddressInfo;
    const isolatedBaseUrl = `http://127.0.0.1:${address.port}`;
    config.dataDir = originalDataDir;

    try {
      const workbookPath = await createKnowledgeWorkbook({
        headers: columns.map((column) => column.name),
        rows: [["商品问题", "破损", "说明"]],
      });
      const form = new FormData();
      form.set("file", new Blob([fs.readFileSync(workbookPath)]), "blocked.xlsx");
      form.set("columns", JSON.stringify(columns));
      const previewResponse = await fetch(
        `${isolatedBaseUrl}/api/sections/${sectionId}/knowledge-bases/import-preview`,
        { method: "POST", body: form },
      );
      const preview = await previewResponse.json() as any;
      const stagedPath = path.join(
        isolatedDataDir,
        "knowledge-previews",
        `${preview.data.token}.xlsx`,
      );
      expect(fs.existsSync(stagedPath)).toBe(true);
      fs.writeFileSync(path.join(isolatedDataDir, "knowledge-imports"), "blocked");

      const confirmResponse = await fetch(
        `${isolatedBaseUrl}/api/sections/${sectionId}/knowledge-bases/import`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: preview.data.token, columns }),
        },
      );
      expect(await confirmResponse.json()).toMatchObject({
        success: false,
        data: null,
      });
      expect(fs.existsSync(stagedPath)).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        isolatedServer.close((error) => error ? reject(error) : resolve());
      });
      fs.rmSync(isolatedDataDir, { recursive: true, force: true });
    }
  });

  it("returns the shared JSON envelope for malformed request JSON", async () => {
    const response = await fetch(`${baseUrl}/api/knowledge-bases/missing/search-test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{\"query\":",
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      success: false,
      data: null,
      error: "请求 JSON 格式无效",
    });
  });

  it("paginates, filters, creates, edits and deletes knowledge items", async () => {
    const base = createBase();
    const first = upsertKnowledgeItem({
      knowledgeBaseId: base.id,
      values: { 一级原因: "商品问题", 二级原因: "破损", 说明: "说明 A" },
      isEnabled: true,
    });
    upsertKnowledgeItem({
      knowledgeBaseId: base.id,
      values: { 一级原因: "物流问题", 二级原因: "超时", 说明: "说明 B" },
      isEnabled: false,
    });

    const page = await jsonRequest(
      `/api/knowledge-bases/${base.id}/items?page=1&pageSize=1&enabled=true&search=商品`,
    );
    expect(page.body).toEqual({
      success: true,
      data: { items: [first], total: 1, page: 1, pageSize: 1 },
      error: null,
    });

    const created = await jsonRequest(`/api/knowledge-bases/${base.id}/items`, {
      method: "POST",
      body: JSON.stringify({
        values: { 一级原因: "服务问题", 二级原因: "态度", 说明: "说明 C" },
        isEnabled: true,
      }),
    });
    expect(created.status).toBe(200);
    expect(created.body.data.knowledgeBaseId).toBe(base.id);

    const edited = await jsonRequest(
      `/api/knowledge-items/${created.body.data.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          values: { 一级原因: "服务问题", 二级原因: "响应", 说明: "已修改" },
          isEnabled: false,
        }),
      },
    );
    expect(edited.body).toMatchObject({
      success: true,
      data: { isEnabled: false, values: { 二级原因: "响应", 说明: "已修改" } },
      error: null,
    });

    const removed = await jsonRequest(
      `/api/knowledge-items/${created.body.data.id}`,
      { method: "DELETE" },
    );
    expect(removed.body).toEqual({ success: true, data: true, error: null });
    expect(listKnowledgeItems(base.id).items.map((entry) => entry.id))
      .not.toContain(created.body.data.id);
  });

  it("updates base state, searches enabled items, and deletes the base", async () => {
    const base = createBase();
    upsertKnowledgeItem({
      knowledgeBaseId: base.id,
      values: { 一级原因: "商品问题", 二级原因: "弹簧片掉落", 说明: "面板组件" },
      isEnabled: true,
    });

    const disabled = await jsonRequest(`/api/knowledge-bases/${base.id}`, {
      method: "PATCH",
      body: JSON.stringify({ isEnabled: false }),
    });
    expect(disabled.body).toMatchObject({
      success: true,
      data: { id: base.id, isEnabled: false },
      error: null,
    });

    const disabledSearch = await jsonRequest(
      `/api/knowledge-bases/${base.id}/search-test`,
      { method: "POST", body: JSON.stringify({ query: "弹簧片掉落" }) },
    );
    expect(disabledSearch.body).toEqual({
      success: true,
      data: [],
      error: null,
    });

    await jsonRequest(`/api/knowledge-bases/${base.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "启用后的知识库", isEnabled: true }),
    });
    const searched = await jsonRequest(
      `/api/knowledge-bases/${base.id}/search-test`,
      { method: "POST", body: JSON.stringify({ query: "面板弹簧片掉落", limit: 5 }) },
    );
    expect(searched.body).toMatchObject({
      success: true,
      data: [{ values: { 二级原因: "弹簧片掉落" } }],
      error: null,
    });

    const removed = await jsonRequest(`/api/knowledge-bases/${base.id}`, {
      method: "DELETE",
    });
    expect(removed.body).toEqual({ success: true, data: true, error: null });
    expect(getKnowledgeBase(base.id)).toBeUndefined();
  });
});
