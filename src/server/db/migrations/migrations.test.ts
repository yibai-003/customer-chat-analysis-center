import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { ensureSectionConfigV1 } from "./018-section-config-versions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appliedMigrations, currentSchemaVersion, migrations, runMigrations } from "./index";
import { applyLegacyBaseline } from "./002-legacy-baseline";
import { applyLostDealKnowledgeMetadata } from "./007-lost-deal-knowledge-metadata";
import { applyReceptionQualityConfiguration } from "./009-reception-quality-normalization";
import { applyUnifiedReceptionQualityConfiguration } from "./010-unified-reception-quality";
import { applyOptimizedReceptionQualityConfiguration } from "./011-optimized-reception-quality-prompts";
import { applyReceptionExcelSchemaConfiguration } from "./013-reception-excel-schema";
import { applyPoolRemovalAndEfficiencyIndexes } from "./015-pool-removal-and-efficiency-indexes";
import { applyModelPools } from "./014-model-pools";

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
    expect(appliedMigrations(db).map(m => m.version)).toEqual([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]);
    expect(db.prepare("SELECT prompt FROM analysis_sections").get().prompt).toBe("keep my prompt");
    const columns = db.prepare("PRAGMA table_info(jobs)").all().map((c: any) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["run_started_at", "heartbeat_at", "run_finished_at"]));
    const before = JSON.stringify(appliedMigrations(db));
    runMigrations(db);
    expect(JSON.stringify(appliedMigrations(db))).toBe(before);
    expect(fs.readdirSync(path.join(dir, "backups/migrations"))).toHaveLength(1);
  });
  it("groups legacy model configs by base URL and ciphertext without rewriting credentials", () => {
    applyLegacyBaseline(db);
    const insert = db.prepare(`
      INSERT INTO model_configs (
        id, name, base_url, api_key_ciphertext, model, purpose, is_purpose_default,
        supports_vision, temperature, max_tokens, is_default, is_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0.2, 1500, ?, 1, '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z')
    `);
    const dashScopeBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    insert.run("qwen-vision", "旧千问视觉", dashScopeBaseUrl, "cipher-shared", "qwen-vl-max", "vision", 1, 1);
    insert.run("qwen-text", "旧千问文本", dashScopeBaseUrl, "cipher-shared", "qwen-plus", "text", 1, 0);
    insert.run("qwen-other-key", "旧千问另一密钥", dashScopeBaseUrl, "cipher-other", "qwen-max", "text", 0, 0);
    insert.run(
      "qwen-other-url",
      "旧千问另一地址",
      "https://dashscope.aliyuncs.com/compatible-mode/v2",
      "cipher-shared",
      "qwen-turbo",
      "text",
      0,
      0,
    );
    insert.run("other", "其他模型", "https://example.com/v1", "cipher-other", "other-model", "text", 1, 0);
    const originalCiphertextById = Object.fromEntries(
      (db.prepare("SELECT id, api_key_ciphertext FROM model_configs").all() as Array<{ id: string; api_key_ciphertext: string }>)
        .map((row) => [row.id, row.api_key_ciphertext]),
    );

    runMigrations(db);

    expect(currentSchemaVersion).toBe(18);
    expect(appliedMigrations(db).map((migration) => migration.version)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    const qwenRows = db.prepare(`
      SELECT
        model.provider_id,
        model.id,
        model.base_url,
        model.api_key_ciphertext,
        provider.base_url AS provider_base_url,
        provider.api_key_ciphertext AS provider_api_key_ciphertext
      FROM model_configs model
      JOIN model_providers provider ON provider.id = model.provider_id
      WHERE model.base_url LIKE '%dashscope.aliyuncs.com%'
      ORDER BY model.id
    `).all() as Array<{
      provider_id: string;
      id: string;
      base_url: string;
      api_key_ciphertext: string;
      provider_base_url: string;
      provider_api_key_ciphertext: string;
    }>;
    expect(qwenRows).toHaveLength(4);
    const qwenById = Object.fromEntries(qwenRows.map((row) => [row.id, row]));
    expect(qwenById["qwen-vision"].provider_id).toBe(qwenById["qwen-text"].provider_id);
    expect(qwenById["qwen-other-key"].provider_id).not.toBe(qwenById["qwen-vision"].provider_id);
    expect(qwenById["qwen-other-url"].provider_id).not.toBe(qwenById["qwen-vision"].provider_id);
    expect(qwenRows.every((row) => row.api_key_ciphertext === originalCiphertextById[row.id])).toBe(true);
    expect(qwenRows.every((row) => row.provider_base_url === row.base_url)).toBe(true);
    expect(qwenRows.every((row) => row.provider_api_key_ciphertext === row.api_key_ciphertext)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) count FROM model_pool_settings").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT paid_daily_token_limit FROM model_pool_settings WHERE id='default'").get())
      .toEqual({ paid_daily_token_limit: 0 });
    expect(db.prepare("SELECT name FROM model_providers WHERE id = ?").get(qwenById["qwen-vision"].provider_id))
      .toEqual({ name: "千问百炼" });

    runMigrations(db);
    applyModelPools(db);

    expect(db.prepare("SELECT COUNT(*) count FROM model_providers").get()).toEqual({ count: 4 });
    expect(db.prepare("SELECT COUNT(*) count FROM model_pool_settings").get()).toEqual({ count: 1 });
  });
  it("adds pool removal fields and efficiency indexes idempotently", () => {
    applyLegacyBaseline(db);
    runMigrations(db);
    applyPoolRemovalAndEfficiencyIndexes(db);

    const columns = (db.prepare("PRAGMA table_info(model_configs)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    for (const name of ["pool_removed_at", "pool_removed_reason", "pool_removed_note"]) {
      expect(columns).toContain(name);
    }
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>)
      .map((row) => row.name);
    for (const name of [
      "idx_field_runs_created_at",
      "idx_field_runs_field_created",
      "idx_model_usage_events_field_created",
    ]) {
      expect(indexes).toContain(name);
    }
    expect(columns.filter((name) => name === "pool_removed_at")).toHaveLength(1);
  });
  it("creates one active organization and identity tables and marks legacy rows as unassigned", () => {
    applyLegacyBaseline(db);
    db.exec(`
      INSERT INTO jobs (id, original_filename, source_path, status, total_records, completed_records, failed_records, created_at, updated_at)
      VALUES ('legacy-job', 'old.xlsx', 'old.xlsx', 'ready', 0, 0, 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    `);
    runMigrations(db);

    expect(db.prepare("SELECT COUNT(*) n FROM organizations WHERE is_active = 1").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_sessions'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_events'").get()).toBeTruthy();
    const columns = (db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["organization_id", "created_by_user_id"]));
    const legacy = db.prepare("SELECT organization_id, created_by_user_id FROM jobs WHERE id = 'legacy-job'").get();
    expect(legacy).toEqual({ organization_id: "org-default", created_by_user_id: null });
    runMigrations(db);
    expect(db.prepare("SELECT COUNT(*) n FROM organizations").get()).toEqual({ n: 1 });
  });
  it("creates immutable section version storage and migrates each current section to V1", () => {
    applyLegacyBaseline(db);
    db.exec(`
      INSERT INTO analysis_sections
        (id, parent_id, name, prompt, output_schema_json, source_fields_json,
         sort_order, is_enabled, image_enabled, created_at, updated_at)
      VALUES ('section-a', NULL, '板块 A', 'prompt-a', '[{"key":"result","label":"结果","type":"string"}]',
        '["平台"]', 1, 1, 1, 'before', 'before');
      INSERT INTO analysis_fields
        (id, section_id, key, label, field_type, prompt, options_json, output_column,
         is_required, image_enabled, depends_on_json, sort_order, is_enabled,
         execution_type, export_enabled, created_at, updated_at)
      VALUES ('field-a', 'section-a', 'result', '结果', 'string', 'field-prompt', '[]',
        '结果', 1, 1, '[]', 0, 1, 'ai', 1, 'before', 'before');
      INSERT INTO knowledge_bases
        (id, section_id, name, original_filename, column_schema_json, item_count, is_enabled, created_at, updated_at)
      VALUES ('base-a', 'section-a', '知识库 A', 'a.xlsx', '[{"name":"原因","roles":["result"]}]', 1, 1, 'before', 'before');
      INSERT INTO knowledge_items
        (id, knowledge_base_id, path_key, values_json, search_text, is_enabled, created_at, updated_at)
      VALUES ('item-a', 'base-a', '原因 A', '{"原因":"原因 A"}', '原因 A', 1, 'before', 'before');
      INSERT INTO jobs
        (id, original_filename, source_path, section_id, section_name, status, created_at, updated_at)
      VALUES ('job-a', 'a.xlsx', 'a.xlsx', 'section-a', '板块 A', 'completed', 'before', 'before');
    `);

    const liveConfigurationBefore = db.prepare(`
      SELECT s.prompt, s.output_schema_json, s.source_fields_json,
             f.prompt AS field_prompt, f.output_column
      FROM analysis_sections s
      JOIN analysis_fields f ON f.section_id = s.id
      WHERE s.id = 'section-a' AND f.id = 'field-a'
    `).get();

    runMigrations(db);

    const version = db.prepare(`
      SELECT section_id, version_number, status, is_current,
             section_snapshot_json, fields_snapshot_json, knowledge_snapshot_json
      FROM analysis_section_versions
      WHERE section_id = 'section-a'
    `).get() as any;
    expect(version).toMatchObject({
      section_id: "section-a",
      version_number: 1,
      status: "published",
      is_current: 1,
    });
    expect(JSON.parse(version.section_snapshot_json)).toMatchObject({
      name: "板块 A",
      prompt: "prompt-a",
      sourceFields: ["平台"],
    });
    expect(JSON.parse(version.fields_snapshot_json)).toEqual([
      expect.objectContaining({ key: "result", prompt: "field-prompt" }),
    ]);
    expect(JSON.parse(version.knowledge_snapshot_json)).toEqual([
      expect.objectContaining({
        id: "base-a",
        items: [expect.objectContaining({ id: "item-a", values: { 原因: "原因 A" } })],
      }),
    ]);
    expect(db.prepare("SELECT section_config_version_id FROM jobs WHERE id='job-a'").get())
      .toEqual({ section_config_version_id: expect.any(String) });
    expect(db.prepare(`
      SELECT s.prompt, s.output_schema_json, s.source_fields_json,
             f.prompt AS field_prompt, f.output_column
      FROM analysis_sections s
      JOIN analysis_fields f ON f.section_id = s.id
      WHERE s.id = 'section-a' AND f.id = 'field-a'
    `).get()).toEqual(liveConfigurationBefore);
    expect(db.prepare(`
      SELECT action, target_id, metadata_json
      FROM audit_events
      WHERE action = 'config.version_migration' AND target_id = 'section-a'
    `).get()).toMatchObject({
      action: "config.version_migration",
      target_id: "section-a",
      metadata_json: JSON.stringify({ sectionId: "section-a", versionNumber: 1, binding: "legacy-v1" }),
    });
  });
  it("does not duplicate V1 snapshots or overwrite existing job bindings when rerun", () => {
    applyLegacyBaseline(db);
    db.exec(`
      INSERT INTO analysis_sections
        (id, name, prompt, output_schema_json, source_fields_json, created_at, updated_at)
      VALUES ('section-a', '板块 A', 'prompt-a', '[]', '[]', 'before', 'before');
      INSERT INTO jobs
        (id, original_filename, source_path, section_id, section_name, status, created_at, updated_at)
      VALUES ('job-a', 'a.xlsx', 'a.xlsx', 'section-a', '板块 A', 'completed', 'before', 'before');
    `);
    runMigrations(db);
    const first = db.prepare("SELECT id FROM analysis_section_versions WHERE section_id='section-a'").get().id;
    const firstSnapshot = db.prepare(
      "SELECT section_snapshot_json, fields_snapshot_json FROM analysis_section_versions WHERE id = ?",
    ).get(first);
    db.prepare("UPDATE jobs SET section_config_version_id = ? WHERE id = 'job-a'").run(first);
    runMigrations(db);
    expect(ensureSectionConfigV1(db)).toEqual({
      succeeded: 0,
      skipped: 1,
      errors: [],
    });
    expect(db.prepare(
      "SELECT section_snapshot_json, fields_snapshot_json FROM analysis_section_versions WHERE id = ?",
    ).get(first)).toEqual(firstSnapshot);
    expect(db.prepare("SELECT COUNT(*) AS count FROM analysis_section_versions WHERE section_id='section-a'").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT section_config_version_id FROM jobs WHERE id = 'job-a'").get())
      .toEqual({ section_config_version_id: first });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM audit_events
      WHERE action = 'config.version_migration' AND target_id = 'section-a'
    `).get()).toEqual({ count: 1 });
  });
  it("rejects edits and deletes of published snapshots while allowing lifecycle metadata changes", () => {
    applyLegacyBaseline(db);
    db.exec(`
      INSERT INTO analysis_sections
        (id, name, prompt, output_schema_json, source_fields_json, created_at, updated_at)
      VALUES ('section-a', '板块 A', 'prompt-a', '[]', '[]', 'before', 'before');
    `);
    runMigrations(db);
    const versionId = db.prepare("SELECT id FROM analysis_section_versions WHERE section_id='section-a'").get().id;
    expect(() => db.prepare(`
      UPDATE analysis_section_versions
      SET section_snapshot_json = '{}'
      WHERE id = ?
    `).run(versionId)).toThrow("已发布配置版本内容不可修改");
    expect(() => db.prepare("DELETE FROM analysis_section_versions WHERE id = ?").run(versionId))
      .toThrow("已发布配置版本不可删除");
    expect(() => db.prepare("DELETE FROM analysis_sections WHERE id = 'section-a'").run())
      .toThrow("存在配置版本的板块不能删除");
    expect(() => db.prepare(`
      UPDATE analysis_section_versions
      SET status = 'draft'
      WHERE id = ?
    `).run(versionId)).toThrow("已发布配置版本不能降级为草稿");
    expect(() => db.prepare(`
      UPDATE analysis_section_versions
      SET is_current = 0, archived_at = 'archived'
      WHERE id = ?
    `).run(versionId)).not.toThrow();
  });
  it("keeps audit events append-only and independent of account deletion", () => {
    applyLegacyBaseline(db);
    runMigrations(db);
    db.prepare(`INSERT INTO audit_events
      (id, organization_id, actor_user_id, actor_display, action, target_type, target_id, outcome, metadata_json, correlation_id, occurred_at)
      VALUES ('audit-1','org-default','ghost-user','历史操作员','task.export','job','job-1','success','{}','req-1','2026-09-17T00:00:00.000Z')`).run();
    expect(() => db.prepare("UPDATE audit_events SET action = 'tampered' WHERE id = 'audit-1'").run())
      .toThrow("审计事件不可修改");
    expect(() => db.prepare("DELETE FROM audit_events WHERE id = 'audit-1'").run())
      .toThrow("审计事件不可删除");
    expect(db.prepare("SELECT action, actor_user_id FROM audit_events WHERE id = 'audit-1'").get())
      .toEqual({ action: "task.export", actor_user_id: "ghost-user" });
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
