import { describe, expect, it } from "vitest";
import type {
  AnalysisField,
  KnowledgeBase,
  KnowledgeCandidate,
  KnowledgeColumn,
  KnowledgeImportPreview,
  KnowledgeItem,
  RecordSummary,
} from "./types";

describe("shared record types", () => {
  it("accepts a record summary returned by the API", () => {
    const summary: RecordSummary = {
      id: "record-1",
      rowNumber: 2,
      sheetName: "Sheet1",
      sourceFields: { customer: "张三" },
      imageUrl: "/api/records/record-1/image",
      status: "pending",
      reviewStatus: "pending",
    };
    expect(summary.status).toBe("pending");
  });

  it("accepts knowledge base types and field execution settings", () => {
    const columns: KnowledgeColumn[] = [
      { name: "一级原因", roles: ["result", "search"] },
      { name: "三级原因", roles: ["result"], requiredParent: "二级原因" },
    ];
    const knowledgeBase: KnowledgeBase = {
      id: "knowledge-base-1",
      sectionId: "refund",
      name: "退货原因",
      originalFilename: "退货原因汇总.xlsx",
      columns,
      itemCount: 388,
      isEnabled: true,
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    };
    const item: KnowledgeItem = {
      id: "knowledge-item-1",
      knowledgeBaseId: knowledgeBase.id,
      values: { 一级原因: "商品问题", 三级原因: "破损" },
      isEnabled: true,
      sourceRowNumber: 2,
      updatedAt: "2026-09-09T00:00:00.000Z",
    };
    const preview: KnowledgeImportPreview = {
      token: "preview-token",
      headers: ["一级原因", "三级原因"],
      totalRows: 1,
      added: 1,
      updated: 0,
      skipped: 0,
      duplicateRows: 0,
      errors: [],
    };
    const candidate: KnowledgeCandidate = {
      itemId: item.id,
      values: item.values,
      score: 1,
      matchedText: "商品问题 破损",
    };
    const field: AnalysisField = {
      id: "field-1",
      sectionId: "refund",
      key: "level3",
      label: "三级原因",
      type: "string",
      prompt: "",
      required: false,
      imageEnabled: false,
      dependsOn: ["reasonPathMatch"],
      sortOrder: 2,
      isEnabled: true,
      executionType: "knowledge_extract",
      exportEnabled: true,
      knowledgeBaseId: knowledgeBase.id,
      candidateLimit: 15,
      matchFieldKey: "reasonPathMatch",
      knowledgeColumn: "三级原因",
    };

    expect(field.executionType).toBe("knowledge_extract");
    expect(candidate.values).toEqual(item.values);
    expect(preview.added).toBe(1);
  });
});
