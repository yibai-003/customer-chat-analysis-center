import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, initDb } from "../../db/client";
import { deleteKnowledgeItem, upsertKnowledgeBase, upsertKnowledgeItem } from "./knowledge-repository";
import type { AnalysisField, KnowledgeCandidate, KnowledgeColumn } from "../../../shared/types";
import { getModelsForPurpose } from "../model-config-service";

vi.mock("./knowledge-search-service", () => ({
  searchKnowledge: vi.fn(),
}));

vi.mock("../model-config-service", () => ({
  getModelForPurpose: vi.fn(() => ({
    id: "text-model",
    name: "Text Model",
    baseUrl: "https://model.example/v1",
    apiKey: "secret",
    model: "text-model",
    temperature: 0,
    maxTokens: 200,
  })),
  getModelsForPurpose: vi.fn(() => [{
    id: "text-model",
    name: "Text Model",
    baseUrl: "https://model.example/v1",
    apiKey: "secret",
    model: "text-model",
    supportsVision: false,
    temperature: 0,
    maxTokens: 200,
  }]),
}));

vi.mock("../../ai/openai-compatible-client", () => ({
  callVisionModel: vi.fn(),
}));

import { callVisionModel } from "../../ai/openai-compatible-client";
import { getModelForPurpose } from "../model-config-service";
import { searchKnowledge } from "./knowledge-search-service";
import { matchKnowledgeItem } from "./knowledge-match-service";

const columns: KnowledgeColumn[] = [
  { name: "原因", roles: ["result"] },
  { name: "检索词", roles: ["search"] },
  { name: "判定说明", roles: ["description"] },
  { name: "正向案例", roles: ["positive_example"] },
  { name: "反向案例", roles: ["negative_example"] },
  { name: "内部备注", roles: ["metadata"] },
];

const field: AnalysisField = {
  id: "field-knowledge-match",
  sectionId: "refund",
  key: "reasonMatch",
  label: "原因匹配",
  type: "string",
  prompt: "根据聊天内容选择最匹配的知识条目",
  required: false,
  imageEnabled: false,
  dependsOn: ["聊天内容"],
  sortOrder: 0,
  isEnabled: true,
  executionType: "knowledge_match",
  knowledgeBaseId: "base-match",
  candidateLimit: 10,
};

function clearTestData() {
  db.exec(`
    DELETE FROM knowledge_match_snapshots;
    DELETE FROM analysis_field_runs;
    DELETE FROM records;
    DELETE FROM jobs;
    DELETE FROM knowledge_item_fts;
    DELETE FROM knowledge_imports;
    DELETE FROM knowledge_items;
    DELETE FROM knowledge_bases;
    DELETE FROM analysis_fields WHERE id = 'field-knowledge-match';
  `);
}

function createRecordAndField() {
  const timestamp = "2026-09-09T00:00:00.000Z";
  db.prepare(`
    INSERT INTO jobs (
      id, original_filename, source_path, section_id, section_name, status,
      total_records, completed_records, failed_records, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)
  `).run(
    "job-match",
    "source.xlsx",
    "source.xlsx",
    "refund",
    "退货分析",
    "processing",
    timestamp,
    timestamp,
  );
  db.prepare(`
    INSERT INTO records (
      id, job_id, sheet_name, row_number, anchor_json, source_fields_json,
      image_path, status, review_status, review_note, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "record-match",
    "job-match",
    "Sheet1",
    2,
    "{}",
    "{}",
    "",
    "processing",
    "pending",
    "",
    timestamp,
    timestamp,
  );
  db.prepare(`
    INSERT INTO analysis_fields (
      id, section_id, key, label, field_type, prompt, options_json,
      is_required, image_enabled, depends_on_json, sort_order, execution_type,
      export_enabled, knowledge_base_id, candidate_limit, is_enabled,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, 1, ?, ?, 1, ?, ?)
  `).run(
    field.id,
    field.sectionId,
    field.key,
    field.label,
    field.type,
    field.prompt,
    "[]",
    JSON.stringify(field.dependsOn),
    field.executionType,
    field.knowledgeBaseId,
    field.candidateLimit,
    timestamp,
    timestamp,
  );
}

function createKnowledge() {
  const base = upsertKnowledgeBase({
    id: "base-match",
    sectionId: "refund",
    name: "退货原因知识库",
    originalFilename: "knowledge.xlsx",
    columns,
    isEnabled: true,
  });
  return upsertKnowledgeItem({
    id: "candidate-panel",
    knowledgeBaseId: base.id,
    values: {
      原因: "品质-面板故障",
      检索词: "面板 弹簧片",
      判定说明: "商品本体功能或结构异常",
      正向案例: "客户提供面板内部照片并确认弹簧片掉落",
      反向案例: "只有客户主观说不好用且没有凭证",
      内部备注: "完整快照必须保留",
    },
    isEnabled: true,
  });
}

describe("knowledge match service", () => {
  beforeAll(() => initDb());
  beforeEach(() => {
    clearTestData();
    createRecordAndField();
    vi.clearAllMocks();
  });

  it("accepts a supplied candidate ID and persists a complete immutable snapshot", async () => {
    const item = createKnowledge();
    const candidates: KnowledgeCandidate[] = [{
      itemId: item.id,
      values: item.values,
      score: 52,
      matchedText: "品质-面板故障 面板 弹簧片",
    }];
    vi.mocked(searchKnowledge).mockReturnValue(candidates);
    vi.mocked(callVisionModel).mockResolvedValue({
      content: '{"knowledgeItemId":"candidate-panel"}',
      raw: '{"choices":[{"message":{"content":"selected"}}]}',
      usage: {},
    });

    const result = await matchKnowledgeItem({
      recordId: "record-match",
      field,
      sectionName: "退货分析",
      dependencies: { 聊天内容: "客户反馈面板里的弹簧片掉了" },
    });

    expect(result).toEqual({
      status: "completed",
      result: { reasonMatch: "candidate-panel" },
      snapshotId: expect.any(String),
    });
    expect(vi.mocked(getModelsForPurpose)).toHaveBeenCalledWith("text");

    const modelMessages = vi.mocked(callVisionModel).mock.calls[0][1];
    const serializedMessages = JSON.stringify(modelMessages);
    expect(serializedMessages).toContain("品质-面板故障");
    expect(serializedMessages).toContain("面板 弹簧片");
    expect(serializedMessages).toContain("商品本体功能或结构异常");
    expect(serializedMessages).toContain("客户提供面板内部照片并确认弹簧片掉落");
    expect(serializedMessages).toContain("只有客户主观说不好用且没有凭证");
    expect(serializedMessages).not.toContain("完整快照必须保留");

    deleteKnowledgeItem(item.id);

    const snapshot = db.prepare(`
      SELECT *
      FROM knowledge_match_snapshots
      WHERE id = ?
    `).get(result.snapshotId) as any;
    expect(snapshot.knowledge_item_id).toBe("candidate-panel");
    expect(JSON.parse(snapshot.item_values_json)).toEqual(item.values);
    expect(JSON.parse(snapshot.candidate_snapshot_json)).toEqual(candidates);
    expect(snapshot.query_snapshot).toContain("客户反馈面板里的弹簧片掉了");
    expect(snapshot.model_response).toContain("choices");
  });

  it("rejects an ID outside the supplied candidate set for review", async () => {
    createKnowledge();
    vi.mocked(searchKnowledge).mockReturnValue([{
      itemId: "candidate-panel",
      values: { 原因: "品质-面板故障" },
      score: 52,
      matchedText: "面板",
    }]);
    vi.mocked(callVisionModel).mockResolvedValue({
      content: '{"knowledgeItemId":"unknown-item"}',
      raw: "unknown-item",
      usage: {},
    });

    await expect(matchKnowledgeItem({
      recordId: "record-match",
      field,
      sectionName: "退货分析",
      dependencies: { 聊天内容: "面板故障" },
    })).resolves.toMatchObject({
      status: "needs_review",
      result: { reasonMatch: "" },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_match_snapshots").get())
      .toEqual({ count: 0 });
  });

  it("treats an empty candidate ID as a valid unmatched result requiring review", async () => {
    const item = createKnowledge();
    vi.mocked(searchKnowledge).mockReturnValue([{
      itemId: item.id,
      values: item.values,
      score: 1,
      matchedText: "无法确认",
    }]);
    vi.mocked(callVisionModel).mockResolvedValue({
      content: '{"knowledgeItemId":""}',
      raw: "empty",
      usage: {},
    });

    await expect(matchKnowledgeItem({
      recordId: "record-match",
      field,
      sectionName: "退货分析",
      dependencies: { 聊天内容: "无法识别的情况" },
    })).resolves.toEqual({
      status: "needs_review",
      result: { reasonMatch: "" },
    });
  });

  it("does not call the text model when local retrieval returns no candidates", async () => {
    vi.mocked(searchKnowledge).mockReturnValue([]);

    await expect(matchKnowledgeItem({
      recordId: "record-match",
      field,
      sectionName: "退货分析",
      dependencies: { 聊天内容: "没有任何可匹配内容" },
    })).resolves.toMatchObject({
      status: "needs_review",
      result: { reasonMatch: "" },
    });

    expect(callVisionModel).not.toHaveBeenCalled();
  });
});
