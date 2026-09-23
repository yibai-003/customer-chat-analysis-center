import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, initDb } from "../db/client";
import { upsertKnowledgeBase } from "./knowledge/knowledge-repository";
import {
  listEnabledFields,
  listFields,
  topologicalFields,
  upsertField,
  validateFieldGraph,
  type AnalysisFieldLike,
} from "./field-config-service";

const field = (key: string, dependsOn: string[]): AnalysisFieldLike => ({
  id: key,
  sectionId: "test",
  key,
  label: key,
  type: "string",
  prompt: key,
  required: false,
  imageEnabled: false,
  dependsOn,
});

describe("field config service", () => {
  beforeAll(() => initDb());
  afterEach(() => {
    db.prepare("DELETE FROM analysis_fields WHERE section_id = 'task-5-config'").run();
    db.prepare("DELETE FROM knowledge_bases WHERE section_id = 'task-5-config'").run();
    db.prepare("DELETE FROM knowledge_bases WHERE section_id = 'refund' AND id = 'task-5-wrong-base'").run();
    db.prepare("DELETE FROM analysis_sections WHERE id = 'task-5-config'").run();
  });

  it("migrates legacy output schema fields into field configs", () => {
    const fields = listFields("reception");
    expect(fields.find((item) => item.key === "conclusion")?.prompt).toContain("问候");
    expect(fields.find((item) => item.key === "conclusion")?.imageEnabled).toBe(true);
  });

  it("lists only active fields for current configuration screens", () => {
    const enabled = listEnabledFields("refund");
    expect(enabled.every((item) => item.isEnabled)).toBe(true);
    expect(enabled.map((item) => item.key)).not.toContain("responsibility");
    expect(enabled.map((item) => item.key)).not.toContain("suggestion");
  });

  it("allows capture only on the internal lost-deal attribution field", () => {
    const attribution = {
      ...field("未成交归因", ["截图内容总结"]),
      sectionId: "lost-deal",
      type: "object" as const,
      executionType: "lost_deal_attribution" as const,
      knowledgeSyncEnabled: true,
    };
    expect(validateFieldGraph([{ ...field("截图内容总结", []), sectionId: "lost-deal" }, attribution])).toEqual([]);
    expect(validateFieldGraph([{ ...attribution, key: "客户原因" }])).toContainEqual(expect.stringContaining("知识沉淀"));
  });

  it("keeps refund analysis to screenshot parsing, knowledge matching, and direct extraction", () => {
    const fields = listFields("refund");
    expect(fields.filter((field) => field.isEnabled).map((field) => field.key)).toEqual([
      "reason",
      "reasonPathMatch",
      "一级选项",
      "二级选项",
      "三级选项",
    ]);
    expect(fields.find((field) => field.key === "reason")).toMatchObject({
      label: "截图解析",
      type: "object",
      executionType: "ai",
      imageEnabled: true,
      exportEnabled: true,
    });
    expect(fields.find((field) => field.key === "reason")?.prompt).toContain("责任线索只能从以下选项中选择一个");
    expect(fields.find((field) => field.key === "reason")?.prompt).toContain("信息充分度只能填写");
    expect(fields.find((field) => field.key === "reasonPathMatch")).toMatchObject({
      executionType: "knowledge_match",
      exportEnabled: false,
      dependsOn: ["reason", "售后问题类型", "商品信息", "产品分类", "产品名称"],
    });
    expect(fields.filter((field) => ["一级选项", "二级选项", "三级选项"].includes(field.key))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ executionType: "knowledge_extract", matchFieldKey: "reasonPathMatch", knowledgeColumn: "一级原因" }),
        expect.objectContaining({ executionType: "knowledge_extract", matchFieldKey: "reasonPathMatch", knowledgeColumn: "二级原因" }),
        expect.objectContaining({ executionType: "knowledge_extract", matchFieldKey: "reasonPathMatch", knowledgeColumn: "三级原因" }),
      ]),
    );
    expect(fields.find((field) => field.key === "responsibility")?.isEnabled).toBe(false);
    expect(fields.find((field) => field.key === "suggestion")?.isEnabled).toBe(false);
  });

  it("orders dependent fields after their dependencies", () => {
    const fields = [
      field("reason", ["screenshotContent"]),
      field("screenshotContent", []),
    ];
    expect(topologicalFields(fields).map((item) => item.key)).toEqual(["screenshotContent", "reason"]);
  });

  it("rejects circular dependencies", () => {
    expect(() => topologicalFields([
      field("a", ["b"]),
      field("b", ["a"]),
    ])).toThrow("循环依赖");
  });

  it("maps and persists execution settings with runtime defaults", () => {
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES (?, NULL, ?, ?, '[]', '[]', 99, 1, 0, ?, ?)
    `).run("task-5-config", "Task 5", "默认提示词", timestamp, timestamp);

    const aiField = upsertField({
      sectionId: "task-5-config",
      key: "summary",
      label: "摘要",
      type: "string",
    });
    expect(aiField).toMatchObject({
      executionType: "ai",
      exportEnabled: true,
      candidateLimit: 15,
    });

    const base = upsertKnowledgeBase({
      id: "task-5-base",
      sectionId: "task-5-config",
      name: "Task 5 知识库",
      originalFilename: "knowledge.xlsx",
      columns: [{ name: "三级原因", roles: ["result"] }],
      isEnabled: true,
    });
    const match = upsertField({
      sectionId: "task-5-config",
      key: "reasonMatch",
      label: "原因匹配",
      type: "string",
      executionType: "knowledge_match",
      knowledgeBaseId: base.id,
      candidateLimit: 8,
    });
    const alternateMatch = upsertField({
      sectionId: "task-5-config",
      key: "alternateMatch",
      label: "备用匹配",
      type: "string",
      executionType: "knowledge_match",
      knowledgeBaseId: base.id,
    });
    upsertField({
      sectionId: "task-5-config",
      key: "context",
      label: "上下文",
      type: "string",
    });
    const extract = upsertField({
      sectionId: "task-5-config",
      key: "level3",
      label: "三级原因",
      type: "string",
      executionType: "knowledge_extract",
      matchFieldKey: match.key,
      knowledgeColumn: "三级原因",
      dependsOn: ["context"],
    });
    const editedExtract = upsertField({
      id: extract.id,
      sectionId: "task-5-config",
      key: extract.key,
      label: extract.label,
      type: extract.type,
      executionType: "knowledge_extract",
      matchFieldKey: alternateMatch.key,
      knowledgeColumn: "三级原因",
      dependsOn: extract.dependsOn,
    });

    expect(listFields("task-5-config")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "reasonMatch",
        executionType: "knowledge_match",
        exportEnabled: false,
        knowledgeBaseId: base.id,
        candidateLimit: 8,
      }),
      expect.objectContaining({
        key: "level3",
        executionType: "knowledge_extract",
        matchFieldKey: "alternateMatch",
        knowledgeColumn: "三级原因",
        dependsOn: ["context", "alternateMatch"],
      }),
    ]));
    expect(match.exportEnabled).toBe(false);
    expect(alternateMatch.exportEnabled).toBe(false);
    expect(editedExtract.dependsOn).toEqual(["context", "alternateMatch"]);
  });

  it("validates knowledge field configuration and section ownership", () => {
    const wrongBase = upsertKnowledgeBase({
      id: "task-5-wrong-base",
      sectionId: "refund",
      name: "其他板块知识库",
      originalFilename: "knowledge.xlsx",
      columns: [{ name: "原因", roles: ["result"] }],
      isEnabled: true,
    });
    const baseField = {
      ...field("match", []),
      executionType: "knowledge_match" as const,
    };

    expect(validateFieldGraph([baseField])).toContain("知识匹配字段未选择知识库：match");
    expect(validateFieldGraph([{
      ...baseField,
      knowledgeBaseId: "missing-base",
    }])).toContain("知识匹配字段知识库不属于当前板块：match");
    expect(validateFieldGraph([{
      ...baseField,
      knowledgeBaseId: wrongBase.id,
    }])).toContain("知识匹配字段知识库不属于当前板块：match");
    expect(validateFieldGraph([{
      ...field("extract", []),
      executionType: "knowledge_extract",
      matchFieldKey: "",
      knowledgeColumn: "",
    }])).toContain("知识提取字段配置不完整：extract");
    expect(validateFieldGraph([
      {
        ...field("extract", ["aiSource"]),
        executionType: "knowledge_extract",
        matchFieldKey: "aiSource",
        knowledgeColumn: "原因",
      },
      {
        ...field("aiSource", []),
        executionType: "ai",
      },
    ])).toContain("知识提取字段匹配来源无效：extract");
    expect(validateFieldGraph([
      {
        ...field("extract", ["matchSource"]),
        executionType: "knowledge_extract",
        matchFieldKey: "matchSource",
        knowledgeColumn: "原因",
      },
      {
        ...field("matchSource", []),
        sectionId: "other-section",
        executionType: "knowledge_match",
      },
    ])).toContain("知识提取字段匹配来源无效：extract");
  });

  it("clears extract-only configuration when changing to AI and preserves other dependencies", () => {
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES (?, NULL, ?, ?, '[]', '["customerContext"]', 99, 1, 0, ?, ?)
    `).run("task-5-config", "Task 5", "默认提示词", timestamp, timestamp);
    const base = upsertKnowledgeBase({
      id: "task-5-conversion-base",
      sectionId: "task-5-config",
      name: "转换测试知识库",
      originalFilename: "knowledge.xlsx",
      columns: [{ name: "原因", roles: ["result"] }],
      isEnabled: true,
    });
    const match = upsertField({
      sectionId: "task-5-config",
      key: "reasonMatch",
      label: "原因匹配",
      type: "string",
      executionType: "knowledge_match",
      knowledgeBaseId: base.id,
    });
    const extract = upsertField({
      id: "task-5-conversion-extract",
      sectionId: "task-5-config",
      key: "reason",
      label: "原因",
      type: "string",
      executionType: "knowledge_extract",
      matchFieldKey: match.key,
      knowledgeColumn: "原因",
      dependsOn: ["customerContext"],
    });

    const converted = upsertField({
      id: extract.id,
      sectionId: "task-5-config",
      key: extract.key,
      label: extract.label,
      type: extract.type,
      executionType: "ai",
      dependsOn: extract.dependsOn,
    });

    expect(converted).toMatchObject({
      executionType: "ai",
      dependsOn: ["customerContext"],
    });
    expect(converted.matchFieldKey).toBeUndefined();
    expect(converted.knowledgeColumn).toBeUndefined();
    expect(converted.knowledgeBaseId).toBeUndefined();
  });

  it("migrates every knowledge execution column onto a legacy analysis_fields table", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-5-legacy-fields-"));
    const databasePath = path.join(tempDir, "legacy.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE analysis_fields (
        id TEXT PRIMARY KEY, section_id TEXT NOT NULL, key TEXT NOT NULL,
        label TEXT NOT NULL, field_type TEXT NOT NULL, prompt TEXT NOT NULL,
        options_json TEXT NOT NULL DEFAULT '[]', output_column TEXT,
        is_required INTEGER NOT NULL DEFAULT 0, image_enabled INTEGER NOT NULL DEFAULT 1,
        depends_on_json TEXT NOT NULL DEFAULT '[]', sort_order INTEGER NOT NULL DEFAULT 0,
        is_enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(section_id, key)
      );
      INSERT INTO analysis_fields (
        id, section_id, key, label, field_type, prompt, options_json,
        output_column, is_required, image_enabled, depends_on_json,
        sort_order, is_enabled, created_at, updated_at
      ) VALUES (
        'legacy-ai-field', 'reception', 'legacy', '旧 AI 字段', 'string',
        '旧提示词', '[]', '旧 AI 字段', 0, 1, '[]', 0, 1,
        '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'
      );
    `);
    legacy.close();

    const previousPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = databasePath;
    vi.resetModules();
    try {
      const migrated = await import("../db/client");
      migrated.initDb();
      const columns = migrated.db.prepare("PRAGMA table_info(analysis_fields)").all() as Array<{
        name: string;
        dflt_value: string | number | null;
      }>;
      expect(columns).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "execution_type", dflt_value: "'ai'" }),
        expect.objectContaining({ name: "export_enabled", dflt_value: "1" }),
        expect.objectContaining({ name: "knowledge_base_id", dflt_value: null }),
        expect.objectContaining({ name: "candidate_limit", dflt_value: "15" }),
        expect.objectContaining({ name: "match_field_key", dflt_value: null }),
        expect.objectContaining({ name: "knowledge_column", dflt_value: null }),
      ]));
      expect(migrated.db.prepare(`
        SELECT execution_type, export_enabled, candidate_limit
        FROM analysis_fields
        WHERE id = 'legacy-ai-field'
      `).get()).toEqual({
        execution_type: "ai",
        export_enabled: 1,
        candidate_limit: 15,
      });
      migrated.db.close();
    } finally {
      if (previousPath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previousPath;
      vi.resetModules();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
