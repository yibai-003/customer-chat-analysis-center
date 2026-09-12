import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, initDb } from "../../db/client";
import { captureCatalog, KnowledgeSync, restoreCatalog } from "./knowledge-sync-service";
import { upsertKnowledgeBase, upsertKnowledgeItem, deleteKnowledgeBase } from "./knowledge-repository";
import { searchKnowledge } from "./knowledge-search-service";
import { createApp } from "../../app";
import { upsertField, getField } from "../field-config-service";

let directory: string;
let sync: KnowledgeSync;
beforeEach(() => {
  initDb();
  db.exec("DELETE FROM knowledge_item_fts; DELETE FROM analysis_sections;");
  initDb();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-sync-test-"));
  sync = new KnowledgeSync(path.join(directory, "catalog.json"), path.join(directory, "state.json"));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

function seedKnowledge() {
  const base = upsertKnowledgeBase({
    id: "portable-base", sectionId: "refund", name: "退货原因", originalFilename: "原因.xlsx",
    columns: [{ name: "原因", roles: ["result", "search"] }], isEnabled: true,
  });
  upsertKnowledgeItem({ id: "portable-item", knowledgeBaseId: base.id, values: { 原因: "面板弹簧掉落" }, isEnabled: true });
  db.prepare("UPDATE analysis_fields SET knowledge_base_id=?,prompt=? WHERE section_id='refund' AND key='reasonPathMatch'")
    .run(base.id, "我的自定义分类提示词");
}

describe("portable knowledge catalog", () => {
  it("round-trips capture settings and accepts old catalogs without changing their hash", () => {
    seedKnowledge(); sync.initialize(false);
    const oldContents = fs.readFileSync(sync.file, "utf8");
    expect(oldContents).toContain("knowledge_sync_enabled");
    sync.initialize(false);
    expect(fs.readFileSync(sync.file, "utf8")).toBe(oldContents);
    const field = upsertField({ sectionId: "hot-topic", key: "高频问题", label: "高频问题", type: "string",
      prompt: "提炼", dependsOn: ["topic"], knowledgeSyncEnabled: true, knowledgeCaptureLimit: 1, imageEnabled: false });
    const catalog = captureCatalog();
    expect(catalog.fields.find((item) => item.id === field.id)).toMatchObject({ knowledge_sync_enabled: 1, knowledge_capture_limit: 1 });
    restoreCatalog(catalog);
    expect(getField(field.id)).toMatchObject({ knowledgeSyncEnabled: true, knowledgeCaptureLimit: 1 });
    const legacy = structuredClone(catalog);
    const row = legacy.fields.find((item) => item.id === field.id)!;
    delete (row as any).knowledge_sync_enabled;
    delete (row as any).knowledge_capture_limit;
    restoreCatalog(legacy);
    expect(getField(field.id)).toMatchObject({ knowledgeSyncEnabled: false, knowledgeCaptureLimit: 2 });
  });
  it("restores Chinese content, IDs, field bindings and search indexes into an empty environment", () => {
    seedKnowledge(); sync.initialize(false);
    const catalog = captureCatalog();
    db.exec("DELETE FROM knowledge_item_fts; DELETE FROM analysis_sections;");
    initDb();
    const other = new KnowledgeSync(sync.file, path.join(directory, "new-state.json"));
    other.initialize(true);
    expect(captureCatalog()).toEqual(catalog);
    expect(searchKnowledge({ knowledgeBaseId: "portable-base", query: "面板弹簧掉落" })).toHaveLength(1);
    initDb({ preserveConfiguration: true });
    other.initialize(false);
    expect(captureCatalog()).toEqual(catalog);
    const contents = fs.readFileSync(sync.file, "utf8");
    expect(contents).toContain("面板弹簧掉落");
    for (const key of ["model_configs", "api_key_ciphertext", "source_path", "image_path", "search_text", "source_import_id"]) {
      expect(contents).not.toContain(`"${key}"`);
    }
  });

  it("applies remote additions and deletions once, with a stable snapshot on restart", () => {
    seedKnowledge(); sync.initialize(false);
    const incoming = captureCatalog();
    incoming.items = [];
    incoming.sections[0].name = "来自 GitHub 的修改";
    fs.writeFileSync(sync.file, JSON.stringify(incoming));
    sync.initialize(false);
    expect(captureCatalog()).toEqual(incoming);
    expect(searchKnowledge({ knowledgeBaseId: "portable-base", query: "面板弹簧掉落" })).toHaveLength(0);
    expect(db.prepare("SELECT item_count FROM knowledge_bases WHERE id='portable-base'").get().item_count).toBe(0);
    const before = fs.readFileSync(sync.file, "utf8");
    sync.initialize(false);
    expect(fs.readFileSync(sync.file, "utf8")).toBe(before);
  });

  it("preserves both copies when local and repository changes conflict", () => {
    sync.initialize(false);
    const incoming = captureCatalog(); incoming.sections[0].name = "远端修改";
    fs.writeFileSync(sync.file, JSON.stringify(incoming));
    db.prepare("UPDATE analysis_sections SET name='本地修改' WHERE id=?").run(incoming.sections[0].id);
    expect(() => sync.initialize(false)).toThrow("同步冲突");
    expect(() => sync.export()).toThrow("仓库知识库已变更");
    expect(captureCatalog().sections[0].name).toBe("本地修改");
    expect(JSON.parse(fs.readFileSync(sync.file, "utf8"))).toEqual(incoming);
  });

  it("rejects malformed catalogs before touching the database, and rolls back SQL failures", () => {
    seedKnowledge(); const before = captureCatalog();
    const invalid = structuredClone(before); invalid.items[0].knowledge_base_id = "missing";
    expect(() => restoreCatalog(invalid)).toThrow("Invalid item base");
    expect(() => restoreCatalog({ ...before, version: 2 })).toThrow();
    expect(captureCatalog()).toEqual(before);
    db.exec("CREATE TEMP TRIGGER reject_catalog BEFORE INSERT ON knowledge_items BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    try { expect(() => restoreCatalog(before)).toThrow("test failure"); }
    finally { db.exec("DROP TRIGGER reject_catalog;"); }
    expect(captureCatalog()).toEqual(before);
    expect(searchKnowledge({ knowledgeBaseId: "portable-base", query: "面板弹簧掉落" })).toHaveLength(1);
  });

  it("exports base deletions with cleared field references", () => {
    seedKnowledge(); sync.initialize(false);
    deleteKnowledgeBase("portable-base"); sync.export();
    const catalog = JSON.parse(fs.readFileSync(sync.file, "utf8"));
    expect(catalog.bases).toHaveLength(0);
    expect(catalog.items).toHaveLength(0);
    expect(catalog.fields.some((f: any) => f.knowledge_base_id === "portable-base")).toBe(false);
  });

  it("automatically snapshots API saves and blocks editing after an incoming Git change", async () => {
    sync.initialize(false);
    const server = createApp({ knowledgeSync: sync }).listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/api/sections/chat`;
    try {
      const response = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "自动保存测试", prompt: "提示词" }) });
      expect(response.status).toBe(200);
      expect(JSON.parse(fs.readFileSync(sync.file, "utf8")).sections.find((s: any) => s.id === "chat").name).toBe("自动保存测试");
      const incoming = captureCatalog(); incoming.sections[0].name = "其他环境修改";
      fs.writeFileSync(sync.file, JSON.stringify(incoming));
      expect((await fetch(url, { method: "DELETE" })).status).toBe(409);
      expect(db.prepare("SELECT id FROM analysis_sections WHERE id='chat'").get()).toBeTruthy();
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

