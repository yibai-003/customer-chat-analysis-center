import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db, initDb } from "../db/client";
import { upsertSection } from "../db/repositories";
import { upsertField } from "./field-config-service";
import { upsertKnowledgeBase, upsertKnowledgeItem } from "./knowledge/knowledge-repository";
import {
  activateSectionVersion,
  archiveSectionVersion,
  createDraftVersion,
  getSectionVersion,
  publishSectionVersion,
  restoreSectionVersion,
  updateDraftSectionVersion,
  deleteDraftSectionVersion,
} from "./section-config-version-service";

beforeAll(() => initDb());

function createConfigFixture() {
  const sectionId = randomUUID();
  upsertSection({
    id: sectionId,
    name: "版本测试板块",
    prompt: "版本测试提示词",
    sourceFields: ["平台"],
  });
  upsertField({
    sectionId,
    key: "result",
    label: "结果",
    type: "string",
    prompt: "字段提示词",
    outputColumn: "结果",
    dependsOn: [],
  });
  const base = upsertKnowledgeBase({
    id: `${sectionId}-base`,
    sectionId,
    name: "版本知识库",
    originalFilename: "version.xlsx",
    columns: [{ name: "原因", roles: ["result"] }],
    isEnabled: true,
  });
  upsertKnowledgeItem({
    id: `${sectionId}-item`,
    knowledgeBaseId: base.id,
    values: { 原因: "测试原因" },
    isEnabled: true,
  });
  return sectionId;
}

describe("section configuration version lifecycle", () => {
  it("creates and publishes the next immutable snapshot as current", () => {
    const sectionId = createConfigFixture();
    const draft = createDraftVersion(sectionId);
    expect(draft).toMatchObject({ sectionId, versionNumber: 1, status: "draft", isCurrent: false });
    expect(draft.sectionSnapshot.prompt).toBe("版本测试提示词");
    expect(draft.fieldsSnapshot).toEqual([
      expect.objectContaining({ key: "result", prompt: "字段提示词" }),
    ]);
    expect(draft.knowledgeSnapshot).toEqual([
      expect.objectContaining({
        id: `${sectionId}-base`,
        items: [expect.objectContaining({ values: { 原因: "测试原因" } })],
      }),
    ]);
    expect(JSON.stringify(draft)).not.toContain("api_key_ciphertext");

    const published = publishSectionVersion(draft.id);
    expect(published).toMatchObject({ status: "published", isCurrent: true, versionNumber: 1 });
    expect(getSectionVersion(draft.id)).toMatchObject({ status: "published", isCurrent: true });
  });

  it("archives, restores, and activates historical versions with valid transitions", () => {
    const sectionId = createConfigFixture();
    const draft = createDraftVersion(sectionId);
    const published = publishSectionVersion(draft.id);
    expect(() => archiveSectionVersion(published.id)).toThrow("当前启用版本");

    const versions = db.prepare(
      "SELECT id FROM analysis_section_versions WHERE section_id = ? AND version_number = 1",
    ).get(sectionId) as { id: string };
    const secondDraft = createDraftVersion(sectionId);
    const secondPublished = publishSectionVersion(secondDraft.id);
    activateSectionVersion(versions.id);
    const archived = archiveSectionVersion(secondPublished.id);
    expect(archived.status).toBe("archived");
    expect(restoreSectionVersion(secondPublished.id)).toMatchObject({ status: "published", isCurrent: false });
    expect(activateSectionVersion(secondPublished.id)).toMatchObject({ status: "published", isCurrent: true });
    expect(() => archiveSectionVersion(secondPublished.id)).toThrow("当前启用版本");
  });

  it("uses monotonically increasing section-local version numbers", () => {
    const sectionId = createConfigFixture();
    const first = createDraftVersion(sectionId);
    publishSectionVersion(first.id);
    const second = createDraftVersion(sectionId);
    expect(second.versionNumber).toBe(2);
  });

  it("allows draft edits and deletion but rejects both operations after publication", () => {
    const sectionId = createConfigFixture();
    const draft = createDraftVersion(sectionId);
    const updated = updateDraftSectionVersion(draft.id, {
      sectionSnapshot: { name: "编辑后的板块" },
      businessRules: { threshold: 10 },
    });
    expect(updated.sectionSnapshot.name).toBe("编辑后的板块");
    expect(updated.businessRules).toEqual({ threshold: 10 });
    deleteDraftSectionVersion(draft.id);
    expect(getSectionVersion(draft.id)).toBeUndefined();

    const publishedDraft = createDraftVersion(sectionId);
    publishSectionVersion(publishedDraft.id);
    expect(() => updateDraftSectionVersion(publishedDraft.id, { businessRules: { threshold: 20 } }))
      .toThrow("只有草稿版本可以编辑");
    expect(() => deleteDraftSectionVersion(publishedDraft.id)).toThrow("只有草稿版本可以删除");
  });

  it("snapshots the current reception issue catalog and grade thresholds", () => {
    const draft = createDraftVersion("reception");
    expect(draft.businessRules).toMatchObject({
      kind: "reception_quality",
      scoreBase: 100,
      forceDGrade: "D",
      gradeThresholds: [
        { grade: "A", minScore: 95 },
        { grade: "B", minScore: 90 },
        { grade: "C", minScore: 80 },
        { grade: "D", minScore: 0 },
      ],
      importContract: {
        imageColumn: "聊天截图",
        resultColumns: [
          "问题点-售前",
          "问题点-售后",
          "有无违规-售后",
          "客服问题 识别问题并打标签",
          "接待流程质检结果",
          "优化建议-售前",
        ],
        completeHistoricalResultRequiredColumns: [
          "问题点-售前",
          "问题点-售后",
          "有无违规-售后",
          "客服问题 识别问题并打标签",
          "接待流程质检结果",
          "优化建议-售前",
        ],
      },
    });
    const issues = draft.businessRules.issues as Array<{ id: string; dimension: string }>;
    expect(issues)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "PRE_ANSWER_IRRELEVANT", dimension: "问题解决" }),
      ]));
    expect(issues.every((issue) => issue.dimension.trim().length > 0)).toBe(true);

    const invalidRules = structuredClone(draft.businessRules) as {
      issues: Array<Record<string, unknown>>;
    };
    delete invalidRules.issues[0].dimension;
    db.prepare("UPDATE analysis_section_versions SET business_rules_json = ? WHERE id = ?")
      .run(JSON.stringify(invalidRules), draft.id);
    expect(() => publishSectionVersion(draft.id)).toThrow("配置参数无效");

    const invalidContract = createDraftVersion("reception");
    const invalidContractRules = structuredClone(invalidContract.businessRules) as {
      importContract: {
        resultColumns: string[];
        completeHistoricalResultRequiredColumns: string[];
      };
    };
    invalidContractRules.importContract.completeHistoricalResultRequiredColumns.push("未声明结果字段");
    db.prepare("UPDATE analysis_section_versions SET business_rules_json = ? WHERE id = ?")
      .run(JSON.stringify(invalidContractRules), invalidContract.id);
    expect(() => publishSectionVersion(invalidContract.id)).toThrow("完整历史结果必填字段不属于结果区");
  });

  it("rejects malformed snapshots and runtime model state", () => {
    const sectionId = createConfigFixture();
    const malformed = createDraftVersion(sectionId);
    expect(() => updateDraftSectionVersion(malformed.id, {
      fieldsSnapshot: "invalid" as never,
    })).toThrow("配置参数无效");

    const sensitive = createDraftVersion(sectionId);
    expect(() => updateDraftSectionVersion(sensitive.id, {
      businessRules: { modelConfig: { apiKey: "secret" } },
    })).toThrow("禁止包含模型运行态字段");
  });
});
