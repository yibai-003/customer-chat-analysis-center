import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, initDb } from "../db/client";
import { analyzeField, analyzeRecordFields, executeFieldGraph } from "./field-analysis-service";
import { createFieldRun, getFieldResultContext } from "./field-run-service";
import type { AnalysisField } from "../../shared/types";

vi.mock("./model-config-service", () => ({
  getModelForPurpose: vi.fn((purpose: "vision" | "text") => ({
    id: `${purpose}-model`,
    name: `${purpose} model`,
    baseUrl: "https://model.example/v1",
    apiKey: "secret",
    model: `${purpose}-model`,
    supportsVision: purpose === "vision",
    temperature: 0,
    maxTokens: 200,
  })),
  getModelsForPurpose: vi.fn((purpose: "vision" | "text") => [{
    id: `${purpose}-model`,
    name: `${purpose} model`,
    baseUrl: "https://model.example/v1",
    apiKey: "secret",
    model: `${purpose}-model`,
    supportsVision: purpose === "vision",
    temperature: 0,
    maxTokens: 200,
  }]),
}));

vi.mock("../ai/openai-compatible-client", () => ({
  callVisionModel: vi.fn(async (_model: unknown, messages: unknown[]) => {
    const serialized = JSON.stringify(messages);
    const key = serialized.includes("图片 AI") ? "imageAi" : "textAi";
    return {
      content: JSON.stringify({ [key]: key === "imageAi" ? "图片结果" : "文本结果" }),
      raw: "{}",
      usage: {},
    };
  }),
  classifyModelError: vi.fn((error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  })),
}));

vi.mock("./knowledge/knowledge-match-service", () => ({
  matchKnowledgeItem: vi.fn(async (input: { field: AnalysisField }) => ({
    status: "completed",
    result: { [input.field.key]: "knowledge-item-1" },
    snapshotId: "task-5-dispatch-snapshot",
  })),
}));

import { callVisionModel } from "../ai/openai-compatible-client";
import { getModelForPurpose, getModelsForPurpose } from "./model-config-service";
import { matchKnowledgeItem } from "./knowledge/knowledge-match-service";

const fields: AnalysisField[] = [
  {
    id: "reason",
    sectionId: "lost-deal",
    key: "reason",
    label: "一级原因",
    type: "string",
    prompt: "根据截图内容判断一级原因",
    required: false,
    imageEnabled: false,
    dependsOn: ["screenshotContent"],
    sortOrder: 1,
    isEnabled: true,
  },
  {
    id: "screenshot",
    sectionId: "lost-deal",
    key: "screenshotContent",
    label: "截图内容",
    type: "string",
    prompt: "读取聊天截图",
    required: true,
    imageEnabled: true,
    dependsOn: [],
    sortOrder: 0,
    isEnabled: true,
  },
];

describe("field analysis executor", () => {
  const imagePath = path.join(os.tmpdir(), "task-5-dispatch.png");

  beforeAll(() => {
    initDb();
    fs.writeFileSync(imagePath, Buffer.from("image"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    db.exec(`
      DELETE FROM knowledge_match_snapshots;
      DELETE FROM analysis_field_runs;
      DELETE FROM records;
      DELETE FROM jobs;
      DELETE FROM analysis_fields WHERE section_id = 'task-5-dispatch';
      DELETE FROM knowledge_bases WHERE section_id = 'task-5-dispatch';
      DELETE FROM analysis_sections WHERE id = 'task-5-dispatch';
    `);
  });

  afterAll(() => {
    fs.rmSync(imagePath, { force: true });
  });

  it("runs screenshot content before dependent reason", async () => {
    const order: string[] = [];
    const result = await executeFieldGraph(fields, async (field, context) => {
      order.push(field.key);
      if (field.key === "reason") expect(context.screenshotContent).toBe("聊天内容");
      return { [field.key]: field.key === "screenshotContent" ? "聊天内容" : "价格原因" };
    });
    expect(order).toEqual(["screenshotContent", "reason"]);
    expect(result.reason.result).toEqual({ reason: "价格原因" });
  });

  it("skips a dependent field when its dependency failed", async () => {
    const result = await executeFieldGraph(fields, async (field) => {
      if (field.key === "screenshotContent") throw new Error("图片解析失败");
      return {};
    });
    expect(result.reason.status).toBe("skipped");
  });

  it("does not rerun unrelated fields when retrying one field", async () => {
    const order: string[] = [];
    await executeFieldGraph([fields[1]], async (field) => {
      order.push(field.key);
      return { [field.key]: "重试结果" };
    });
    expect(order).toEqual(["screenshotContent"]);
  });

  it("dispatches each field by execution type and never selects a model for extraction", async () => {
    const timestamp = "2026-09-09T00:00:00.000Z";
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES (?, NULL, ?, '', '[]', '[]', 99, 1, 1, ?, ?)
    `).run("task-5-dispatch", "字段分派", timestamp, timestamp);
    db.prepare(`
      INSERT INTO knowledge_bases (
        id, section_id, name, original_filename, column_schema_json,
        item_count, is_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, 'knowledge.xlsx', ?, 0, 1, ?, ?)
    `).run(
      "task-5-base",
      "task-5-dispatch",
      "字段分派知识库",
      JSON.stringify([{ name: "原因", roles: ["result"] }]),
      timestamp,
      timestamp,
    );
    db.prepare(`
      INSERT INTO jobs (
        id, original_filename, source_path, status, total_records,
        completed_records, failed_records, created_at, updated_at
      ) VALUES (?, 'source.xlsx', 'source.xlsx', 'ready', 1, 0, 0, ?, ?)
    `).run("task-5-dispatch-job", timestamp, timestamp);
    db.prepare(`
      INSERT INTO records (
        id, job_id, sheet_name, row_number, anchor_json, source_fields_json,
        image_path, status, review_status, review_note, created_at, updated_at
      ) VALUES (?, ?, 'Sheet1', 2, '{}', '{}', ?, 'pending', 'pending', '', ?, ?)
    `).run("task-5-dispatch-record", "task-5-dispatch-job", imagePath, timestamp, timestamp);

    const insertField = db.prepare(`
      INSERT INTO analysis_fields (
        id, section_id, key, label, field_type, prompt, options_json,
        is_required, image_enabled, depends_on_json, sort_order, execution_type,
        export_enabled, knowledge_base_id, candidate_limit, match_field_key,
        knowledge_column, is_enabled, created_at, updated_at
      ) VALUES (?, 'task-5-dispatch', ?, ?, 'string', ?, '[]', 0, ?, ?, ?, ?, 1, ?, 15, ?, ?, 1, ?, ?)
    `);
    insertField.run("task-5-image", "imageAi", "图片 AI", "图片 AI", 1, "[]", 0, "ai", null, null, null, timestamp, timestamp);
    insertField.run("task-5-text", "textAi", "普通 AI", "普通 AI", 0, "[]", 1, "ai", null, null, null, timestamp, timestamp);
    insertField.run("task-5-match", "reasonMatch", "知识匹配", "知识匹配", 0, "[]", 2, "knowledge_match", "task-5-base", null, null, timestamp, timestamp);
    insertField.run("task-5-extract", "reasonName", "知识提取", "知识提取", 0, '["reasonMatch"]', 3, "knowledge_extract", null, "reasonMatch", "原因", timestamp, timestamp);
    db.prepare(`
      INSERT INTO knowledge_match_snapshots (
        id, record_id, field_id, knowledge_base_id, knowledge_item_id,
        item_values_json, candidate_snapshot_json, query_snapshot,
        model_response, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, '[]', '{}', '{}', ?)
    `).run(
      "task-5-existing-snapshot",
      "task-5-dispatch-record",
      "task-5-match",
      "task-5-base",
      "knowledge-item-1",
      JSON.stringify({ 原因: "品质问题" }),
      timestamp,
    );

    const progress = await analyzeRecordFields("task-5-dispatch-record", "task-5-dispatch");

    expect(progress).toEqual({
      total: 4,
      completed: 4,
      failed: 0,
      needsReview: 0,
      skipped: 0,
    });
    expect(vi.mocked(getModelsForPurpose).mock.calls.map(([purpose]) => purpose)).toEqual([
      "vision",
      "text",
    ]);
    expect(callVisionModel).toHaveBeenCalledTimes(2);
    expect(matchKnowledgeItem).toHaveBeenCalledTimes(1);
    const extractRun = db.prepare(`
      SELECT result_json, model_config_snapshot_json
      FROM analysis_field_runs
      WHERE field_id = 'task-5-extract'
    `).get() as { result_json: string; model_config_snapshot_json: string };
    expect(JSON.parse(extractRun.result_json)).toEqual({ reasonName: "品质问题" });
    expect(JSON.parse(extractRun.model_config_snapshot_json)).toEqual({});
  });

  it("records a failed field run when the field-specific model is unavailable", async () => {
    const timestamp = "2026-09-09T00:00:00.000Z";
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES (?, NULL, ?, '', '[]', '[]', 99, 1, 0, ?, ?)
    `).run("task-5-dispatch", "字段分派", timestamp, timestamp);
    db.prepare(`
      INSERT INTO jobs (
        id, original_filename, source_path, status, total_records,
        completed_records, failed_records, created_at, updated_at
      ) VALUES (?, 'source.xlsx', 'source.xlsx', 'ready', 1, 0, 0, ?, ?)
    `).run("task-5-dispatch-job", timestamp, timestamp);
    db.prepare(`
      INSERT INTO records (
        id, job_id, sheet_name, row_number, anchor_json, source_fields_json,
        image_path, status, review_status, review_note, created_at, updated_at
      ) VALUES (?, ?, 'Sheet1', 2, '{}', '{}', '', 'pending', 'pending', '', ?, ?)
    `).run("task-5-dispatch-record", "task-5-dispatch-job", timestamp, timestamp);
    db.prepare(`
      INSERT INTO analysis_fields (
        id, section_id, key, label, field_type, prompt, options_json,
        is_required, image_enabled, depends_on_json, sort_order, execution_type,
        export_enabled, candidate_limit, is_enabled, created_at, updated_at
      ) VALUES (?, 'task-5-dispatch', 'textAi', '普通 AI', 'string', '普通 AI', '[]',
        0, 0, '[]', 0, 'ai', 1, 15, 1, ?, ?)
    `).run("task-5-text", timestamp, timestamp);
    vi.mocked(getModelsForPurpose).mockImplementationOnce(() => {
      throw new Error("请先配置并启用默认模型");
    });

    await expect(analyzeRecordFields(
      "task-5-dispatch-record",
      "task-5-dispatch",
    )).resolves.toEqual({
      total: 1,
      completed: 0,
      failed: 1,
      needsReview: 0,
      skipped: 0,
    });
    expect(db.prepare(`
      SELECT status, error_message
      FROM analysis_field_runs
      WHERE field_id = 'task-5-text'
    `).get()).toEqual({
      status: "failed",
      error_message: "请先配置并启用默认模型",
    });
  });

  it("reports only the current rerun states after an earlier failed run", async () => {
    const timestamp = "2026-09-09T00:00:00.000Z";
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES (?, NULL, ?, '', '[]', '[]', 99, 1, 0, ?, ?)
    `).run("task-5-dispatch", "字段重跑", timestamp, timestamp);
    db.prepare(`
      INSERT INTO jobs (
        id, original_filename, source_path, status, total_records,
        completed_records, failed_records, created_at, updated_at
      ) VALUES (?, 'source.xlsx', 'source.xlsx', 'ready', 1, 0, 0, ?, ?)
    `).run("task-5-dispatch-job", timestamp, timestamp);
    db.prepare(`
      INSERT INTO records (
        id, job_id, sheet_name, row_number, anchor_json, source_fields_json,
        image_path, status, review_status, review_note, created_at, updated_at
      ) VALUES (?, ?, 'Sheet1', 2, '{}', '{}', '', 'pending', 'pending', '', ?, ?)
    `).run("task-5-dispatch-record", "task-5-dispatch-job", timestamp, timestamp);
    db.prepare(`
      INSERT INTO analysis_fields (
        id, section_id, key, label, field_type, prompt, options_json,
        is_required, image_enabled, depends_on_json, sort_order, execution_type,
        export_enabled, candidate_limit, is_enabled, created_at, updated_at
      ) VALUES (?, 'task-5-dispatch', 'textAi', '普通 AI', 'string', '普通 AI', '[]',
        0, 0, '[]', 0, 'ai', 1, 15, 1, ?, ?)
    `).run("task-5-text", timestamp, timestamp);
    vi.mocked(getModelsForPurpose).mockImplementationOnce(() => {
      throw new Error("首次模型失败");
    });

    await expect(analyzeRecordFields(
      "task-5-dispatch-record",
      "task-5-dispatch",
    )).resolves.toMatchObject({ failed: 1, completed: 0 });
    await expect(analyzeRecordFields(
      "task-5-dispatch-record",
      "task-5-dispatch",
    )).resolves.toEqual({
      total: 1,
      completed: 1,
      failed: 0,
      needsReview: 0,
      skipped: 0,
    });
  });

  it("filters dependency context by the current section for same-key fields", () => {
    const timestamp = "2026-09-09T00:00:00.000Z";
    for (const [id, name] of [["task-5-context-a", "板块 A"], ["task-5-context-b", "板块 B"]] as const) {
      db.prepare(`
        INSERT INTO analysis_sections (
          id, parent_id, name, prompt, output_schema_json, source_fields_json,
          sort_order, is_enabled, image_enabled, created_at, updated_at
        ) VALUES (?, NULL, ?, '', '[]', '[]', 99, 1, 0, ?, ?)
      `).run(id, name, timestamp, timestamp);
    }
    db.prepare(`
      INSERT INTO jobs (
        id, original_filename, source_path, status, total_records,
        completed_records, failed_records, created_at, updated_at
      ) VALUES (?, 'source.xlsx', 'source.xlsx', 'ready', 1, 0, 0, ?, ?)
    `).run("task-5-context-job", timestamp, timestamp);
    db.prepare(`
      INSERT INTO records (
        id, job_id, sheet_name, row_number, anchor_json, source_fields_json,
        image_path, status, review_status, review_note, created_at, updated_at
      ) VALUES (?, ?, 'Sheet1', 2, '{}', '{}', '', 'pending', 'pending', '', ?, ?)
    `).run("task-5-context-record", "task-5-context-job", timestamp, timestamp);
    const insertField = db.prepare(`
      INSERT INTO analysis_fields (
        id, section_id, key, label, field_type, prompt, options_json,
        is_required, image_enabled, depends_on_json, sort_order, execution_type,
        export_enabled, candidate_limit, is_enabled, created_at, updated_at
      ) VALUES (?, ?, 'sameKey', ?, 'string', '', '[]', 0, 0, '[]', 0, 'ai', 1, 15, 1, ?, ?)
    `);
    insertField.run("task-5-context-field-a", "task-5-context-a", "A 同名字段", timestamp, timestamp);
    insertField.run("task-5-context-field-b", "task-5-context-b", "B 同名字段", timestamp, timestamp);
    createFieldRun({
      recordId: "task-5-context-record",
      fieldId: "task-5-context-field-a",
      status: "completed",
      result: { sameKey: "A 的结果" },
    });
    createFieldRun({
      recordId: "task-5-context-record",
      fieldId: "task-5-context-field-b",
      status: "completed",
      result: { sameKey: "B 的结果" },
    });

    expect(getFieldResultContext(
      "task-5-context-record",
      ["sameKey"],
      "task-5-context-a",
    )).toEqual({ sameKey: "A 的结果" });
    expect(getFieldResultContext(
      "task-5-context-record",
      ["sameKey"],
      "task-5-context-b",
    )).toEqual({ sameKey: "B 的结果" });
  });
});
