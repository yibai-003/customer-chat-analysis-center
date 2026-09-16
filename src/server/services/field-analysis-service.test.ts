import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, initDb } from "../db/client";
import { updateRecord } from "../db/repositories";
import { analyzeField, analyzeRecordFields, executeFieldGraph } from "./field-analysis-service";
import { createFieldRun, getFieldResultContext } from "./field-run-service";
import { listKnowledgeItems } from "./knowledge/knowledge-repository";
import type { AnalysisField } from "../../shared/types";

const modelPoolDefaults = {
  poolEnabled: false,
  billingMode: "paid" as const,
  qualityTier: "A" as const,
  priority: 100,
  thinkingMode: false,
  memberType: "general" as const,
  quotaUsedTokens: 0,
  quotaSafetyRatio: 0.95,
  consecutiveFailures: 0,
  capabilityEligible: false,
  quotaBlocked: false,
};

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

vi.mock("../ai/openai-compatible-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai/openai-compatible-client")>();
  return {
    ...actual,
    callVisionModel: vi.fn(),
  };
});

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

async function defaultModelCall(_model: unknown, messages: unknown[]) {
  const { currentModelBudget } = await import("../ai/model-budget");
  currentModelBudget()?.consume();
  const serialized = JSON.stringify(messages);
  if (serialized.includes("customerReasons")) {
    return {
      content: JSON.stringify({
        customerReasons: [{ knowledgeItemId: "lost-customer-item", evidence: "客户说预算只有100元", confidence: 0.92 }],
        serviceReasons: [{ knowledgeItemId: "lost-service-item", evidence: "客户询问保障但客服未回应", confidence: 0.82 }],
        demandTypes: [{ name: "价格需求", evidence: "客户询问优惠", confidence: 0.88 }],
        specificDemand: "希望优惠到100元",
        specificDemandEvidence: "客户说预算只有100元",
        evidence: ["客户说预算只有100元", "客户询问保障但客服未回应"],
        confidence: 0.86,
      }),
      raw: "{}",
      usage: {},
    };
  }
  const lostDealSummary = serialized.includes("未成交分析");
  const key = lostDealSummary ? "截图内容总结" : serialized.includes("图片 AI") ? "imageAi" : "textAi";
  return {
    content: JSON.stringify({ [key]: lostDealSummary
      ? "客户说预算只有100元。客户询问保障但客服未回应。客户询问优惠。"
      : key === "imageAi" ? "图片结果" : "文本结果" }),
    raw: "{}",
    usage: {},
  };
}

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
    vi.mocked(callVisionModel).mockImplementation(defaultModelCall);
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

  it("runs one vision call and one unified quality call for reception pre-sale and after-sale outputs", async () => {
    const timestamp = "2026-09-16T00:00:00.000Z";
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES (?, NULL, ?, '', '[]', '[]', 99, 1, 1, ?, ?)
    `).run("task-5-dispatch", "接待流程质检", timestamp, timestamp);
    db.prepare(`
      INSERT INTO jobs (
        id, original_filename, source_path, status, total_records,
        completed_records, failed_records, created_at, updated_at
      ) VALUES (?, 'reception.xlsx', 'reception.xlsx', 'ready', 1, 0, 0, ?, ?)
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
        export_enabled, candidate_limit, is_enabled, created_at, updated_at
      ) VALUES (?, 'task-5-dispatch', ?, ?, ?, ?, '[]', 0, ?, ?, ?, ?, ?, 15, 1, ?, ?)
    `);
    insertField.run("reception-facts", "截图内容总结", "截图内容总结", "object", "只抽取事实", 1, "[]", 0, "ai", 0, timestamp, timestamp);
    insertField.run("reception-quality", "统一质检分析", "统一质检分析", "object", "统一售前售后标准", 0, '["截图内容总结"]', 1, "reception_quality_analysis", 0, timestamp, timestamp);
    for (const [index, key] of [
      "问题点-售前",
      "问题点-售后",
      "有无违规-售后",
      "客服问题识别问题并打标签",
      "接待流程质检结果",
      "优化建议-售前",
    ].entries()) {
      insertField.run(
        `task-5-reception-derived-${index}`,
        key,
        key,
        "string",
        "",
        0,
        '["统一质检分析"]',
        index + 2,
        "reception_quality_derive",
        1,
        timestamp,
        timestamp,
      );
    }
    vi.mocked(callVisionModel)
      .mockImplementationOnce(async () => ({
        content: JSON.stringify({
          截图内容总结: {
            会话场景: "混合",
            聊天内容总结: "客户先咨询尺寸，后申请退款。",
            证据片段: ["客户：尺寸多大", "客户：我要退款"],
          },
        }),
        raw: '{"facts":true}',
        usage: {},
      }))
      .mockImplementationOnce(async () => ({
        content: JSON.stringify({
          scene: "混合",
          preSaleIssues: [{
            name: "答非所问",
            evidence: "客服：请看详情页",
            reason: "未回答客户尺寸问题",
            deduction: 10,
            forceD: false,
            violationCount: 1,
          }],
          afterSaleIssues: [{
            name: "漏回复",
            evidence: "客户提出退款后无人工回复",
            reason: "没有有效回应退款诉求",
            deduction: 0,
            forceD: false,
            violationCount: 1,
          }],
          unverifiableItems: [],
          suggestion: "先回答尺寸，再明确说明退款处理步骤",
          confidence: 0.9,
        }),
        raw: '{"quality":true}',
        usage: {},
      }));

    const progress = await analyzeRecordFields("task-5-dispatch-record", "task-5-dispatch");

    expect(progress).toEqual({
      total: 8,
      completed: 8,
      failed: 0,
      needsReview: 0,
      skipped: 0,
    });
    expect(callVisionModel).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getModelsForPurpose).mock.calls.map(([purpose]) => purpose)).toEqual(["vision", "text"]);
    const runs = db.prepare(`
      SELECT f.key, r.result_json, r.model_config_snapshot_json
      FROM analysis_field_runs r
      JOIN analysis_fields f ON f.id = r.field_id
      WHERE r.record_id = ?
    `).all("task-5-dispatch-record") as Array<{
      key: string;
      result_json: string;
      model_config_snapshot_json: string;
    }>;
    const results = Object.fromEntries(runs.map((run) => [run.key, JSON.parse(run.result_json)]));
    expect(results["接待流程质检结果"]).toEqual({ 接待流程质检结果: "B" });
    expect(results["有无违规-售后"]).toEqual({ "有无违规-售后": "有违规" });
    expect(results["客服问题识别问题并打标签"]).toEqual({
      客服问题识别问题并打标签: "答非所问、漏回复",
    });
    expect(runs.filter((run) => JSON.parse(run.model_config_snapshot_json).strategy === "local_rules")).toHaveLength(6);
  });

  it("reuses a completed summary and recalculates descendants after an upstream retry", async () => {
    const timestamp = "2026-09-15T00:00:00.000Z";
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES (?, NULL, ?, '', '[]', '[]', 99, 1, 1, ?, ?)
    `).run("task-5-dispatch", "未成交分析", timestamp, timestamp);
    const insertBase = db.prepare(`
      INSERT INTO knowledge_bases (
        id, section_id, name, original_filename, column_schema_json,
        item_count, is_enabled, created_at, updated_at
      ) VALUES (?, 'task-5-dispatch', ?, '系统初始化', ?, 1, 1, ?, ?)
    `);
    insertBase.run(
      "lost-customer-base",
      "客户未成交原因库",
      JSON.stringify([{ name: "原因名称", roles: ["result", "search"] }]),
      timestamp,
      timestamp,
    );
    insertBase.run(
      "lost-service-base",
      "客服促单问题库",
      JSON.stringify([{ name: "问题名称", roles: ["result", "search"] }]),
      timestamp,
      timestamp,
    );
    db.prepare(`
      INSERT INTO knowledge_items (
        id, knowledge_base_id, path_key, values_json, search_text,
        is_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      "lost-customer-item",
      "lost-customer-base",
      JSON.stringify(["价格超出预算"]),
      JSON.stringify({ 原因名称: "价格超出预算" }),
      "价格超出预算",
      timestamp,
      timestamp,
    );
    db.prepare(`
      INSERT INTO knowledge_items (
        id, knowledge_base_id, path_key, values_json, search_text,
        is_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      "lost-service-item",
      "lost-service-base",
      JSON.stringify(["未处理客户顾虑"]),
      JSON.stringify({ 问题名称: "未处理客户顾虑" }),
      "未处理客户顾虑",
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
        export_enabled, knowledge_base_id, candidate_limit, is_enabled, created_at, updated_at
      ) VALUES (?, 'task-5-dispatch', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 15, 1, ?, ?)
    `);
    insertField.run("lost-summary", "截图内容总结", "图片 AI", "string", "图片 AI", "[]", 1, "[]", 0, "ai", 1, null, timestamp, timestamp);
    insertField.run("lost-attribution", "未成交归因", "未成交归因", "object", "统一归因", JSON.stringify(["价格需求", "尺寸需求"]), 0, '["截图内容总结"]', 1, "lost_deal_attribution", 0, null, timestamp, timestamp);
    insertField.run("lost-customer", "客户原因", "客户原因", "string", "", "[]", 0, '["未成交归因"]', 2, "lost_deal_derive", 1, null, timestamp, timestamp);
    insertField.run("lost-service", "客服原因", "客服原因", "string", "", "[]", 0, '["未成交归因"]', 3, "lost_deal_derive", 1, null, timestamp, timestamp);
    insertField.run("lost-demand", "客户产品需求", "客户产品需求", "string", "", "[]", 0, '["未成交归因"]', 4, "lost_deal_derive", 1, null, timestamp, timestamp);
    insertField.run("lost-script", "话术逻辑优化建议", "话术逻辑优化建议", "string", "", "[]", 0, '["未成交归因"]', 5, "lost_deal_script", 1, null, timestamp, timestamp);
    db.prepare("UPDATE analysis_fields SET knowledge_sync_enabled = 1 WHERE id = 'lost-attribution'").run();

    const progress = await analyzeRecordFields("task-5-dispatch-record", "task-5-dispatch");
    const diagnostic = db.prepare("SELECT error_message FROM analysis_field_runs WHERE field_id = 'lost-attribution' ORDER BY rowid DESC LIMIT 1").get() as { error_message: string | null } | undefined;
    expect(diagnostic?.error_message).toBeNull();

    expect(progress).toEqual({
      total: 6,
      completed: 6,
      failed: 0,
      needsReview: 0,
      skipped: 0,
    });
    expect(callVisionModel).toHaveBeenCalledTimes(2);
    expect(vi.mocked(callVisionModel).mock.calls.map((call) => call[2])).toEqual([
      { attempts: 1 },
      { attempts: 1 },
    ]);
    expect(vi.mocked(getModelsForPurpose).mock.calls.map(([purpose]) => purpose)).toEqual(["vision", "text"]);
    const runs = db.prepare(`
      SELECT f.key, r.result_json
      FROM analysis_field_runs r
      JOIN analysis_fields f ON f.id = r.field_id
      WHERE r.record_id = ?
    `).all("task-5-dispatch-record") as Array<{ key: string; result_json: string }>;
    const results = Object.fromEntries(runs.map((run) => [run.key, JSON.parse(run.result_json)]));
    expect(results["客户原因"]).toEqual({ 客户原因: "价格超出预算" });
    expect(results["客服原因"]).toEqual({ 客服原因: "未处理客户顾虑" });
    expect(results["客户产品需求"]).toEqual({ 客户产品需求: "希望优惠到100元" });
    expect(results["话术逻辑优化建议"]["话术逻辑优化建议"]).toContain("预算");
    const links = db.prepare("SELECT knowledge_item_id, reason_type FROM lost_deal_record_reasons WHERE record_id = ? ORDER BY reason_type").all("task-5-dispatch-record");
    expect(links).toEqual([
      { knowledge_item_id: "lost-customer-item", reason_type: "customer" },
      { knowledge_item_id: "lost-service-item", reason_type: "service" },
    ]);
    expect(listKnowledgeItems("lost-customer-base").items[0].occurrenceCount).toBe(1);
    const attributionResult = db.prepare(`
      SELECT result_json FROM analysis_field_runs
      WHERE record_id = ? AND field_id = 'lost-attribution'
      ORDER BY rowid DESC LIMIT 1
    `).get("task-5-dispatch-record") as { result_json: string };
    createFieldRun({
      recordId: "task-5-dispatch-record",
      fieldId: "lost-attribution",
      status: "needs_review",
      result: JSON.parse(attributionResult.result_json),
      errorMessage: "人工复核",
    });
    updateRecord("task-5-dispatch-record", { status: "needs_review", reviewStatus: "needs_review" });
    await analyzeRecordFields("task-5-dispatch-record", "task-5-dispatch");
    expect(db.prepare("SELECT COUNT(*) count FROM lost_deal_record_reasons WHERE record_id = ?").get("task-5-dispatch-record").count).toBe(2);
    expect(listKnowledgeItems("lost-customer-base").items[0].occurrenceCount).toBe(1);
    expect(callVisionModel).toHaveBeenCalledTimes(3);

    createFieldRun({
      recordId: "task-5-dispatch-record",
      fieldId: "lost-attribution",
      status: "failed",
      result: {},
      errorMessage: "需求类型条目格式无效",
    });
    updateRecord("task-5-dispatch-record", { status: "failed", reviewStatus: "needs_review" });
    await analyzeRecordFields("task-5-dispatch-record", "task-5-dispatch");
    expect(callVisionModel).toHaveBeenCalledTimes(4);

    createFieldRun({
      recordId: "task-5-dispatch-record",
      fieldId: "lost-attribution",
      status: "failed",
      result: {},
      errorMessage: "中断前归因失败",
    });
    updateRecord("task-5-dispatch-record", { status: "pending", reviewStatus: "pending" });
    await analyzeRecordFields("task-5-dispatch-record", "task-5-dispatch");
    expect(callVisionModel).toHaveBeenCalledTimes(5);

    vi.mocked(callVisionModel).mockImplementationOnce(async () => ({
      content: JSON.stringify({
        customerReasons: [{ knowledgeItemId: "lost-customer-item", evidence: "客户说预算只有100元", confidence: 0.9 }],
        serviceReasons: [{ knowledgeItemId: "lost-service-item", evidence: "客户询问保障但客服未回应", confidence: 0.9 }],
        demandTypes: ["价格需求"],
        specificDemand: "希望优惠到100元",
        specificDemandEvidence: "客户说预算只有100元",
        evidence: ["客户说预算只有100元"],
        confidence: 0.9,
      }),
      raw: '{"model":"string-demand"}',
      usage: {},
    }));
    createFieldRun({
      recordId: "task-5-dispatch-record",
      fieldId: "lost-attribution",
      status: "failed",
      result: {},
      errorMessage: "模型返回字符串数组",
    });
    updateRecord("task-5-dispatch-record", { status: "failed", reviewStatus: "needs_review" });
    const reviewed = await analyzeRecordFields("task-5-dispatch-record", "task-5-dispatch");
    expect(reviewed).toMatchObject({ failed: 0, skipped: 0, needsReview: 5, completed: 1 });
    expect(callVisionModel).toHaveBeenCalledTimes(6);

    vi.mocked(callVisionModel).mockImplementationOnce(async () => ({
      content: JSON.stringify({
        customerReasons: [],
        serviceReasons: [],
        demandTypes: [42],
        specificDemand: "",
        specificDemandEvidence: "",
        evidence: [],
        confidence: 0.9,
      }),
      raw: '{"model":"malformed-demand"}',
      usage: {},
    }));
    await analyzeField("task-5-dispatch-record", "task-5-dispatch", "未成交归因");
    const failedRaw = db.prepare(`
      SELECT status, raw_response FROM analysis_field_runs
      WHERE record_id = ? AND field_id = 'lost-attribution'
      ORDER BY rowid DESC LIMIT 1
    `).get("task-5-dispatch-record") as { status: string; raw_response: string | null };
    expect(failedRaw).toEqual({ status: "failed", raw_response: '{"model":"malformed-demand"}' });
    expect(callVisionModel).toHaveBeenCalledTimes(7);

    const descendantRunsBefore = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM analysis_field_runs
      WHERE record_id = ? AND field_id IN ('lost-attribution', 'lost-customer', 'lost-service', 'lost-demand', 'lost-script')
    `).get("task-5-dispatch-record") as { count: number }).count;
    await analyzeField("task-5-dispatch-record", "task-5-dispatch", "截图内容总结");
    const descendantRunsAfter = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM analysis_field_runs
      WHERE record_id = ? AND field_id IN ('lost-attribution', 'lost-customer', 'lost-service', 'lost-demand', 'lost-script')
    `).get("task-5-dispatch-record") as { count: number }).count;

    expect(callVisionModel).toHaveBeenCalledTimes(9);
    expect(descendantRunsAfter - descendantRunsBefore).toBe(5);
  });

  it("stops model fallback after a permanent authentication error", async () => {
    const timestamp = "2026-09-15T00:00:00.000Z";
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES (?, NULL, ?, '', '[]', '[]', 99, 1, 0, ?, ?)
    `).run("task-5-dispatch", "永久错误", timestamp, timestamp);
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
    vi.mocked(getModelsForPurpose).mockReturnValue([
      { ...modelPoolDefaults, id: "first", name: "first", baseUrl: "https://first.example/v1", apiKey: "x", maskedApiKey: "***", model: "first", purpose: "text", supportsVision: false, temperature: 0, maxTokens: 100, isDefault: false, isPurposeDefault: true, isEnabled: true },
      { ...modelPoolDefaults, id: "second", name: "second", baseUrl: "https://second.example/v1", apiKey: "x", maskedApiKey: "***", model: "second", purpose: "text", supportsVision: false, temperature: 0, maxTokens: 100, isDefault: false, isPurposeDefault: false, isEnabled: true },
    ]);
    vi.mocked(callVisionModel).mockRejectedValue(new Error("401 unauthorized"));

    await analyzeRecordFields("task-5-dispatch-record", "task-5-dispatch");

    expect(callVisionModel).toHaveBeenCalledTimes(1);
  });

  it("caps all model requests for one record at four", async () => {
    const timestamp = "2026-09-15T00:00:00.000Z";
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES (?, NULL, ?, '', '[]', '[]', 99, 1, 0, ?, ?)
    `).run("task-5-dispatch", "记录预算", timestamp, timestamp);
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
    vi.mocked(getModelsForPurpose).mockReturnValue(Array.from({ length: 6 }, (_, index) => ({
      ...modelPoolDefaults,
      id: `model-${index}`,
      name: `model-${index}`,
      baseUrl: "https://model.example/v1",
      apiKey: "x",
      maskedApiKey: "***",
      model: `model-${index}`,
      purpose: "text" as const,
      supportsVision: false,
      temperature: 0,
      maxTokens: 100,
      isDefault: false,
      isPurposeDefault: index === 0,
      isEnabled: true,
    })));
    vi.mocked(callVisionModel).mockImplementation(async () => {
      const { currentModelBudget } = await import("../ai/model-budget");
      currentModelBudget()?.consume();
      throw new Error("network failure");
    });

    await analyzeRecordFields("task-5-dispatch-record", "task-5-dispatch");

    expect(callVisionModel).toHaveBeenCalledTimes(4);
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
    createFieldRun({
      recordId: "task-5-context-record",
      fieldId: "task-5-context-field-a",
      status: "failed",
      result: {},
      errorMessage: "最新运行失败",
    });
    expect(getFieldResultContext(
      "task-5-context-record",
      ["sameKey"],
      "task-5-context-a",
    )).toEqual({});
  });
});
