import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appliedMigrations, migrations, runMigrations } from "./index";
import { applyLegacyBaseline } from "./002-legacy-baseline";
import { applyLostDealKnowledgeMetadata } from "./007-lost-deal-knowledge-metadata";
import { applyReceptionQualityConfiguration } from "./009-reception-quality-normalization";
import { applyUnifiedReceptionQualityConfiguration } from "./010-unified-reception-quality";
import { applyOptimizedReceptionQualityConfiguration } from "./011-optimized-reception-quality-prompts";
import { applyReceptionExcelSchemaConfiguration } from "./013-reception-excel-schema";

let dir: string;
let db: any;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-migrations-")); db = new Database(path.join(dir, "app.db")); });
afterEach(() => { if (db.open) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
describe("versioned migrations", () => {
  it("upgrades a legacy version-1 schema without resetting configuration and stays idempotent", () => {
    applyLegacyBaseline(db);
    db.prepare("INSERT INTO schema_migrations VALUES(1,'legacy','2026-01-01')").run();
    db.exec("INSERT INTO analysis_sections(id,name,prompt,output_schema_json,created_at,updated_at) VALUES('custom','name','keep my prompt','[]','before','before')");
    runMigrations(db);
    expect(appliedMigrations(db).map(m => m.version)).toEqual([1,2,3,4,5,6,7,8,9,10,11,12,13]);
    expect(db.prepare("SELECT prompt FROM analysis_sections").get().prompt).toBe("keep my prompt");
    const columns = db.prepare("PRAGMA table_info(jobs)").all().map((c: any) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["run_started_at", "heartbeat_at", "run_finished_at"]));
    const before = JSON.stringify(appliedMigrations(db));
    runMigrations(db);
    expect(JSON.stringify(appliedMigrations(db))).toBe(before);
    expect(fs.readdirSync(path.join(dir, "backups/migrations"))).toHaveLength(1);
  });
  it("replaces legacy reception prompts with compact structured protocols", () => {
    applyLegacyBaseline(db);
    db.exec(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES ('reception', NULL, '接待流程质检', '', '[]', '[]', 1, 1, 1, 'now', 'now');
      INSERT INTO analysis_fields (
        id, section_id, key, label, field_type, prompt, options_json, output_column,
        is_required, image_enabled, depends_on_json, sort_order, is_enabled,
        execution_type, export_enabled, knowledge_sync_enabled, knowledge_capture_limit,
        created_at, updated_at
      ) VALUES
        ('facts', 'reception', '截图内容总结', '截图内容总结', 'object', '旧事实提示词', '[]', NULL,
          1, 1, '[]', 0, 1, 'ai', 0, 0, 2, 'now', 'now'),
        ('quality', 'reception', '统一质检分析', '统一质检分析', 'object', '旧售前售后提示词', '[]', NULL,
          1, 0, '["截图内容总结"]', 1, 1, 'reception_quality_analysis', 0, 0, 2, 'now', 'now');
    `);

    applyOptimizedReceptionQualityConfiguration(db);

    const facts = db.prepare("SELECT prompt FROM analysis_fields WHERE id = 'facts'").get() as { prompt: string };
    const quality = db.prepare("SELECT prompt FROM analysis_fields WHERE id = 'quality'").get() as { prompt: string };
    expect(facts.prompt).toContain("dialogueTurns");
    expect(quality.prompt).toContain("问题ID");
    expect(quality.prompt).toContain("逐项核查当前场景");
    expect(quality.prompt).toContain("适用条件、触发条件和排除条件");
    expect(quality.prompt).not.toContain("旧售前售后提示词");
    expect(quality.prompt.length).toBeLessThan(800);
  });
  it("aligns reception source fields and output columns with the actual Excel schema", () => {
    applyLegacyBaseline(db);
    db.exec(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES ('reception', NULL, '接待流程质检', '', '[]', '["商品编码"]', 1, 1, 1, 'now', 'now');
    `);
    const insert = db.prepare(`
      INSERT INTO analysis_fields (
        id, section_id, key, label, field_type, prompt, options_json, output_column,
        is_required, image_enabled, depends_on_json, sort_order, is_enabled,
        execution_type, export_enabled, knowledge_sync_enabled, knowledge_capture_limit,
        created_at, updated_at
      ) VALUES (?, 'reception', ?, ?, 'string', '', '[]', ?, 0, 0, '[]', ?, 1,
        'reception_quality_derive', 1, 0, 2, 'now', 'now')
    `);
    for (const [index, key] of [
      "问题点-售前", "问题点-售后", "有无违规-售后", "客服问题识别问题并打标签",
      "接待流程质检结果", "优化建议-售前",
    ].entries()) insert.run(`field-${index}`, key, key, key, index);

    applyReceptionExcelSchemaConfiguration(db);

    const section = db.prepare("SELECT source_fields_json FROM analysis_sections WHERE id = 'reception'").get() as {
      source_fields_json: string;
    };
    expect(JSON.parse(section.source_fields_json)).toEqual([
      "平台", "店铺", "日期", "客服", "客户ID", "分组", "平台店铺商品编码", "商品名称", "聊天截图", "订单号",
      "颜色款式", "品类", "问题点-售前", "问题点-售后", "有无违规-售后", "客服问题 识别问题并打标签",
      "接待流程质检结果", "优化建议-售前", "组长复检文本", "创建时间",
    ]);
    expect(db.prepare(
      "SELECT output_column FROM analysis_fields WHERE section_id = 'reception' AND key = '客服问题识别问题并打标签'",
    ).get()).toEqual({ output_column: "客服问题 识别问题并打标签" });
  });
  it("initializes lost-deal fields and knowledge bases without deleting historical runs", () => {
    applyLegacyBaseline(db);
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES ('lost-deal', NULL, '未成交分析', '', '[]', '[]', 1, 1, 1, 'now', 'now')
    `).run();
    runMigrations(db);
    const bases = db.prepare(`
      SELECT id, name FROM knowledge_bases
      WHERE section_id = 'lost-deal'
      ORDER BY id
    `).all();
    expect(bases).toEqual([
      { id: "lost-deal-customer-reasons", name: "客户未成交原因库" },
      { id: "lost-deal-service-reasons", name: "客服促单问题库" },
    ]);
    expect(db.prepare(`
      SELECT execution_type, export_enabled, depends_on_json, knowledge_sync_enabled
      FROM analysis_fields
      WHERE section_id = 'lost-deal' AND key = '未成交归因'
    `).get()).toEqual({
      execution_type: "lost_deal_attribution",
      export_enabled: 0,
      depends_on_json: '["截图内容总结"]',
      knowledge_sync_enabled: 1,
    });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='lost_deal_record_reasons'").get()).toBeTruthy();
  });
  it("adds lost-deal knowledge metadata without overwriting existing item data", () => {
    applyLegacyBaseline(db);
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES ('lost-deal', NULL, '未成交分析', '', '[]', '[]', 1, 1, 1, 'now', 'now')
    `).run();
    applyLostDealKnowledgeMetadata(db);
    const customerId = "lost-deal-customer-reasons-1";
    const existing = JSON.parse((db.prepare(
      "SELECT values_json FROM knowledge_items WHERE id = ?",
    ).get(customerId) as { values_json: string }).values_json);
    db.prepare("UPDATE knowledge_items SET values_json = ? WHERE id = ?").run(JSON.stringify({
      ...existing,
      示例表达: "这个价格超过我的预算",
      自定义备注: "保留人工补充",
    }), customerId);

    applyLostDealKnowledgeMetadata(db);

    const bases = db.prepare(`
      SELECT id, column_schema_json
      FROM knowledge_bases
      WHERE id IN ('lost-deal-customer-reasons', 'lost-deal-service-reasons')
      ORDER BY id
    `).all() as Array<{ id: string; column_schema_json: string }>;
    expect(JSON.parse(bases[0].column_schema_json).map((column: { name: string }) => column.name))
      .toEqual(["原因名称", "定义", "适用条件", "排除条件", "示例表达"]);
    expect(JSON.parse(bases[1].column_schema_json).map((column: { name: string }) => column.name))
      .toEqual(["问题名称", "定义", "适用条件", "排除条件", "改进方向", "示例话术"]);
    const preserved = JSON.parse((db.prepare(
      "SELECT values_json FROM knowledge_items WHERE id = ?",
    ).get(customerId) as { values_json: string }).values_json);
    expect(preserved).toMatchObject({
      原因名称: "价格超出预算",
      示例表达: "这个价格超过我的预算",
      自定义备注: "保留人工补充",
    });
    const service = JSON.parse((db.prepare(
      "SELECT values_json FROM knowledge_items WHERE id = 'lost-deal-service-reasons-1'",
    ).get() as { values_json: string }).values_json);
    expect(service.改进方向).toBeTruthy();
    expect(service.示例话术).toBeTruthy();
  });
  it("normalizes reception quality to one visual fact extraction", () => {
    applyLegacyBaseline(db);
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES ('reception', 'chat', '接待流程质检', '', '[]', '[]', 1, 1, 1, 'now', 'now')
    `).run();
    const insert = db.prepare(`
      INSERT INTO analysis_fields (
        id, section_id, key, label, field_type, prompt, options_json, output_column,
        is_required, image_enabled, depends_on_json, sort_order, is_enabled,
        execution_type, export_enabled, knowledge_sync_enabled, knowledge_capture_limit,
        created_at, updated_at
      ) VALUES (?, 'reception', ?, ?, 'string', 'prompt', '[]', ?, 0, 1, '[]', ?, 1,
        'ai', 1, 0, 2, 'now', 'now')
    `);
    for (const [key, sort] of [
      ["问题点-售前", 0],
      ["问题点-售后", 1],
      ["有无违规-售后", 2],
      ["接待流程质检结果", 3],
      ["客服问题识别问题并打标签", 4],
      ["优化建议-售前", 5],
    ] as const) {
      insert.run(`field-${sort}`, key, key, key, sort);
    }

    applyReceptionQualityConfiguration(db);

    const fields = db.prepare(`
      SELECT key, field_type, is_required, image_enabled, depends_on_json, is_enabled, sort_order, export_enabled
      FROM analysis_fields WHERE section_id = 'reception' ORDER BY sort_order
    `).all();
    expect(fields).toEqual([
      {
        key: "截图内容总结",
        field_type: "object",
        is_required: 1,
        image_enabled: 1,
        depends_on_json: "[]",
        is_enabled: 1,
        sort_order: 0,
        export_enabled: 0,
      },
      {
        key: "问题点-售前",
        field_type: "string",
        is_required: 1,
        image_enabled: 0,
        depends_on_json: '["截图内容总结"]',
        is_enabled: 1,
        sort_order: 1,
        export_enabled: 1,
      },
      {
        key: "客服问题识别问题并打标签",
        field_type: "string",
        is_required: 0,
        image_enabled: 0,
        depends_on_json: '["问题点-售前"]',
        is_enabled: 1,
        sort_order: 2,
        export_enabled: 1,
      },
      {
        key: "接待流程质检结果",
        field_type: "string",
        is_required: 0,
        image_enabled: 0,
        depends_on_json: '["问题点-售前"]',
        is_enabled: 1,
        sort_order: 3,
        export_enabled: 1,
      },
      {
        key: "优化建议-售前",
        field_type: "string",
        is_required: 0,
        image_enabled: 0,
        depends_on_json: '["问题点-售前"]',
        is_enabled: 1,
        sort_order: 4,
        export_enabled: 1,
      },
      {
        key: "问题点-售后",
        field_type: "string",
        is_required: 0,
        image_enabled: 0,
        depends_on_json: "[]",
        is_enabled: 0,
        sort_order: 90,
        export_enabled: 1,
      },
      {
        key: "有无违规-售后",
        field_type: "string",
        is_required: 0,
        image_enabled: 0,
        depends_on_json: "[]",
        is_enabled: 0,
        sort_order: 91,
        export_enabled: 1,
      },
    ]);
    const sourceFields = db.prepare("SELECT source_fields_json FROM analysis_sections WHERE id = 'reception'").get() as {
      source_fields_json: string;
    };
    expect(JSON.parse(sourceFields.source_fields_json)).toEqual([
      "平台", "店铺", "日期", "客服", "客户ID", "分组", "商品编码", "商品名称",
      "聊天截图", "订单号", "颜色款式", "品类", "问题点-售前", "接待流程质检结果",
      "优化建议-售前", "组长复检文本", "创建时间",
    ]);
  });
  it("combines reception pre-sale and after-sale quality into one AI analysis", () => {
    applyLegacyBaseline(db);
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES ('reception', 'chat', '接待流程质检', '', '[]', '[]', 1, 1, 1, 'now', 'now')
    `).run();
    const insert = db.prepare(`
      INSERT INTO analysis_fields (
        id, section_id, key, label, field_type, prompt, options_json, output_column,
        is_required, image_enabled, depends_on_json, sort_order, is_enabled,
        execution_type, export_enabled, knowledge_sync_enabled, knowledge_capture_limit,
        created_at, updated_at
      ) VALUES (?, 'reception', ?, ?, 'string', ?, '[]', ?, 0, 0, '[]', ?, 1,
        'ai', 1, 0, 2, 'now', 'now')
    `);
    insert.run("facts", "截图内容总结", "截图内容总结", "facts", "截图内容总结", 0);
    insert.run("pre", "问题点-售前", "问题点-售前", "售前标准", "问题点-售前", 1);
    insert.run("post", "问题点-售后", "问题点-售后", "售后标准", "问题点-售后", 2);

    applyUnifiedReceptionQualityConfiguration(db);

    const fields = db.prepare(`
      SELECT key, execution_type, image_enabled, depends_on_json, export_enabled, is_enabled
      FROM analysis_fields WHERE section_id = 'reception' ORDER BY sort_order
    `).all() as Array<Record<string, unknown>>;
    expect(fields.filter((field) => field.execution_type === "reception_quality_analysis")).toEqual([
      expect.objectContaining({
        key: "统一质检分析",
        image_enabled: 0,
        depends_on_json: '["截图内容总结"]',
        export_enabled: 0,
        is_enabled: 1,
      }),
    ]);
    expect(fields.filter((field) => field.execution_type === "reception_quality_derive")).toHaveLength(6);
    expect(fields.filter((field) => field.execution_type === "reception_quality_derive")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "问题点-售前", is_enabled: 1 }),
        expect.objectContaining({ key: "问题点-售后", is_enabled: 1 }),
        expect.objectContaining({ key: "有无违规-售后", is_enabled: 1 }),
      ]),
    );
    expect((db.prepare(
      "SELECT prompt FROM analysis_fields WHERE section_id = 'reception' AND key = '统一质检分析'",
    ).get() as { prompt: string }).prompt).toContain("售前标准");
    expect((db.prepare(
      "SELECT prompt FROM analysis_fields WHERE section_id = 'reception' AND key = '统一质检分析'",
    ).get() as { prompt: string }).prompt).toContain("售后标准");
    const prompt = (db.prepare(
      "SELECT prompt FROM analysis_fields WHERE section_id = 'reception' AND key = '统一质检分析'",
    ).get() as { prompt: string }).prompt;
    applyUnifiedReceptionQualityConfiguration(db);
    expect((db.prepare(
      "SELECT prompt FROM analysis_fields WHERE section_id = 'reception' AND key = '统一质检分析'",
    ).get() as { prompt: string }).prompt).toBe(prompt);
  });
  it("rolls back all pending schema changes and version stamps on failure", () => {
    db.exec("CREATE TABLE original(value TEXT); INSERT INTO original VALUES('preserve');");
    expect(() => runMigrations(db, [...migrations, { version: 6, name: "broken", up: (d) => { d.exec("CREATE TABLE partial(id INTEGER)"); throw new Error("injected failure"); } }])).toThrow("injected failure");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get()).toBeUndefined();
    expect(appliedMigrations(db)).toEqual([]);
    expect(db.prepare("SELECT value FROM original").get().value).toBe("preserve");
    const file = fs.readdirSync(path.join(dir, "backups/migrations"))[0];
    const backup = new Database(path.join(dir, "backups/migrations", file), { readonly: true });
    expect(backup.pragma("integrity_check", { simple: true })).toBe("ok"); backup.close();
  });
  it("rejects a newer schema before making changes", () => {
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT); INSERT INTO schema_migrations VALUES(99,'future','now')");
    expect(() => runMigrations(db)).toThrow("高于当前代码");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='jobs'").get()).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "backups"))).toBe(false);
  });
  it("read-only diagnostic commands neither create missing databases nor migrate old ones", async () => {
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT); INSERT INTO schema_migrations VALUES(1,'legacy','old')");
    db.close();
    const file = path.join(dir, "app.db");
    const before = fs.readFileSync(file);
    const exec = promisify(execFile);
    await exec(process.execPath, ["--import", "tsx", "src/server/db-migration-cli.ts"], { cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: file }, windowsHide: true });
    expect(fs.readFileSync(file)).toEqual(before);
    for (const command of ["db-check-cli.ts", "db-migration-cli.ts"]) {
      const missing = path.join(dir, "missing.db");
      await expect(exec(process.execPath, ["--import", "tsx", `src/server/${command}`], { cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: missing }, windowsHide: true })).rejects.toThrow();
      expect(fs.existsSync(missing)).toBe(false);
    }
  });
});
