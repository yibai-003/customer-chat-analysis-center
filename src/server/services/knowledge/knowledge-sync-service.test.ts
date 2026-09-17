import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, initDb } from "../../db/client";
import { captureCatalog, KnowledgeSync, restoreCatalog, validateCatalog } from "./knowledge-sync-service";
import { upsertKnowledgeBase, upsertKnowledgeItem, deleteKnowledgeBase } from "./knowledge-repository";
import { searchKnowledge } from "./knowledge-search-service";
import { createApp } from "../../app";
import { upsertField, getField } from "../field-config-service";

let directory: string;
let sync: KnowledgeSync;
beforeEach(() => {
  initDb();
  db.exec(`
    DELETE FROM knowledge_item_fts;
    DELETE FROM knowledge_items;
    DELETE FROM knowledge_bases WHERE section_id = 'lost-deal';
    DELETE FROM analysis_fields WHERE section_id = 'lost-deal';
  `);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-sync-test-"));
  sync = new KnowledgeSync(path.join(directory, "catalog.json"), path.join(directory, "state.json"));
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

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
  it("ships complete lost-deal customer and service metadata in the repository catalog", () => {
    const catalog = validateCatalog(JSON.parse(
      fs.readFileSync(path.resolve("knowledge/catalog.json"), "utf8"),
    ));
    const customerBase = catalog.bases.find((base) => base.id === "lost-deal-customer-reasons")!;
    const serviceBase = catalog.bases.find((base) => base.id === "lost-deal-service-reasons")!;
    expect(JSON.parse(customerBase.column_schema_json).map((column: { name: string }) => column.name))
      .toEqual(["原因名称", "定义", "适用条件", "排除条件", "示例表达"]);
    expect(JSON.parse(serviceBase.column_schema_json).map((column: { name: string }) => column.name))
      .toEqual(["问题名称", "定义", "适用条件", "排除条件", "改进方向", "示例话术"]);
    const customerItems = catalog.items.filter((item) => item.knowledge_base_id === customerBase.id);
    const serviceItems = catalog.items.filter((item) => item.knowledge_base_id === serviceBase.id);
    expect(customerItems.length).toBeGreaterThan(0);
    expect(serviceItems.length).toBeGreaterThan(0);
    expect(customerItems.every((item) => Boolean(JSON.parse(item.values_json).示例表达))).toBe(true);
    expect(serviceItems.every((item) => {
      const values = JSON.parse(item.values_json);
      return Boolean(values.改进方向 && values.示例话术);
    })).toBe(true);
  });
  it("keeps historical field runs when a restored catalog omits an old field", () => {
    const timestamp = "2026-09-15T00:00:00.000Z";
    db.prepare(`
      INSERT INTO jobs (
        id, original_filename, source_path, status, total_records,
        completed_records, failed_records, created_at, updated_at
      ) VALUES ('history-job', 'history.xlsx', 'history.xlsx', 'ready', 1, 0, 0, ?, ?)
    `).run(timestamp, timestamp);
    db.prepare(`
      INSERT INTO records (
        id, job_id, sheet_name, row_number, anchor_json, source_fields_json,
        image_path, status, review_status, review_note, created_at, updated_at
      ) VALUES ('history-record', 'history-job', 'Sheet1', 2, '{}', '{}', '', 'completed', 'confirmed', '', ?, ?)
    `).run(timestamp, timestamp);
    const old = upsertField({
      sectionId: "lost-deal", key: "历史旧字段", label: "历史旧字段",
      type: "string", imageEnabled: false, exportEnabled: true,
    });
    db.prepare(`
      INSERT INTO analysis_field_runs (
        id, record_id, field_id, status, result_json, dependencies_json,
        prompt_snapshot, field_snapshot_json, model_config_snapshot_json, created_at
      ) VALUES ('history-run', 'history-record', ?, 'completed', ?, '{}', '', '{}', '{}', ?)
    `).run(old.id, JSON.stringify({ 历史旧字段: "保留原结果" }), timestamp);
    const incoming = captureCatalog();
    incoming.fields = incoming.fields.filter((field) => field.id !== old.id);

    restoreCatalog(incoming);

    expect(db.prepare("SELECT result_json FROM analysis_field_runs WHERE id='history-run'").get())
      .toEqual({ result_json: JSON.stringify({ 历史旧字段: "保留原结果" }) });
    expect(getField(old.id)).toMatchObject({ isEnabled: false, exportEnabled: false });
  });
  it("persists pending state with SQL writes, rolls it back with failed writes and recovers after restart", () => {
    sync.initialize(false);
    const before = db.prepare("SELECT revision FROM knowledge_sync_outbox").get().revision;
    expect(() => db.transaction(() => { db.prepare("UPDATE analysis_sections SET name='rollback' WHERE id='chat'").run(); throw new Error("rollback"); })()).toThrow();
    expect(db.prepare("SELECT revision FROM knowledge_sync_outbox").get().revision).toBe(before);
    db.prepare("UPDATE analysis_sections SET name='saved before crash' WHERE id='chat'").run();
    expect(sync.status().state).toBe("pending");
    const restarted = new KnowledgeSync(sync.file, sync.stateFile);
    restarted.initialize(false);
    expect(restarted.status().state).toBe("synced");
    expect(JSON.parse(fs.readFileSync(sync.file, "utf8")).sections.find((s: any) => s.id === "chat").name).toBe("saved before crash");
  });
  it("retries a failed file export after restart without replaying the mutation", () => {
    seedKnowledge(); sync.initialize(false); const original = fs.readFileSync(sync.file, "utf8");
    db.prepare("UPDATE knowledge_items SET values_json=? WHERE id='portable-item'").run(JSON.stringify({ 原因: "新原因" }));
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("disk full"); });
    expect(() => sync.export()).toThrow("disk full");
    expect(sync.status()).toMatchObject({ state: "pending", error: "EXPORT_FAILED" });
    expect(fs.readFileSync(sync.file, "utf8")).toBe(original);
    const restarted = new KnowledgeSync(sync.file, sync.stateFile); restarted.initialize(false);
    expect(restarted.status().state).toBe("pending");
    vi.restoreAllMocks(); restarted.export();
    expect(restarted.status().state).toBe("synced"); expect(captureCatalog().items).toHaveLength(1);
    expect(captureCatalog().items[0].values_json).toContain("新原因");
  });
  it("recovers when the catalog was written but the state file failed, without false conflict", () => {
    sync.initialize(false); db.prepare("UPDATE analysis_sections SET name='new value' WHERE id='chat'").run();
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (to === sync.stateFile) throw new Error("state unavailable"); rename(from, to); });
    expect(() => sync.export()).toThrow("state unavailable");
    expect(() => sync.assertUnchanged()).not.toThrow();
    vi.restoreAllMocks();
    const restarted = new KnowledgeSync(sync.file, sync.stateFile); restarted.initialize(false);
    expect(restarted.status().state).toBe("synced");
  });
  it("never overwrites a conflicting incoming file while export is pending", () => {
    sync.initialize(false);
    db.prepare("UPDATE analysis_sections SET name='local' WHERE id='chat'").run();
    const remote = captureCatalog(); remote.sections.find(s => s.id === "chat")!.name = "remote";
    fs.writeFileSync(sync.file, JSON.stringify(remote));
    const restarted = new KnowledgeSync(sync.file, sync.stateFile);
    expect(() => restarted.initialize(false)).toThrow(); expect(() => restarted.export()).toThrow();
    expect(restarted.status().state).toBe("conflict");
    expect(captureCatalog().sections.find(s => s.id === "chat")!.name).toBe("local");
    expect(JSON.parse(fs.readFileSync(sync.file, "utf8"))).toEqual(remote);
  });
  it("reports database save success when snapshot export fails and retries only the snapshot through HTTP", async () => {
    sync.initialize(false); const server = createApp({ knowledgeSync: sync }).listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("no space"); });
      const saved = await fetch(base + "/api/sections/chat", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "saved once", prompt: "keep" }) });
      expect(saved.status).toBe(200); expect(await saved.json()).toMatchObject({ success: true, sync: { state: "pending" } });
      const revision = db.prepare("SELECT revision FROM knowledge_sync_outbox").get().revision;
      expect((await fetch(base + "/api/knowledge-sync/retry", { method: "POST" })).status).toBe(503);
      vi.restoreAllMocks();
      expect(await (await fetch(base + "/api/knowledge-sync/retry", { method: "POST" })).json()).toMatchObject({ success: true, data: { state: "synced", github: "not_checked" } });
      expect(db.prepare("SELECT revision FROM knowledge_sync_outbox").get().revision).toBe(revision);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
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

