import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db, initDb } from "../db/client";
import { upsertSection } from "../db/repositories";
import { getField, upsertField } from "./field-config-service";
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
    expect(draft.exportSettings.outputColumns).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "platform_name", outputColumn: "平台", source: "platform_name" }),
      expect.objectContaining({ key: "conversation_id", outputColumn: "会话ID", source: "conversation_id" }),
      expect.objectContaining({ key: "result", outputColumn: "结果", source: "field_result" }),
    ]));
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

  it("creates a new draft from the published configuration snapshot", () => {
    const sectionId = createConfigFixture();
    const first = createDraftVersion(sectionId);
    updateDraftSectionVersion(first.id, {
      sectionSnapshot: { prompt: "已发布提示词" },
      fieldsSnapshot: first.fieldsSnapshot.map((field) => ({ ...field, prompt: "已发布字段提示词" })),
    });
    publishSectionVersion(first.id);

    upsertSection({ id: sectionId, name: "旧实时板块", prompt: "旧实时提示词", sourceFields: ["旧输入"] });
    upsertField({
      id: getField(first.fieldsSnapshot[0].id)!.id,
      sectionId,
      key: "result",
      label: "旧实时字段",
      type: "string",
      prompt: "旧实时字段提示词",
      outputColumn: "旧实时列",
      dependsOn: [],
    });

    const next = createDraftVersion(sectionId);
    expect(next.sectionSnapshot).toMatchObject({ name: "版本测试板块", prompt: "已发布提示词" });
    expect(next.fieldsSnapshot[0]).toMatchObject({ label: "结果", prompt: "已发布字段提示词" });
    expect(next.knowledgeSnapshot).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `${sectionId}-base` }),
    ]));
  });

  it("projects newly published fields into the runtime field registry", () => {
    const sectionId = createConfigFixture();
    const draft = createDraftVersion(sectionId);
    const added = {
      ...draft.fieldsSnapshot[0],
      id: `${sectionId}-new-field`,
      key: "new_result",
      label: "新结果",
      outputColumn: "新结果",
    };
    updateDraftSectionVersion(draft.id, {
      fieldsSnapshot: [added],
    });
    publishSectionVersion(draft.id);

    expect(db.prepare(
      "SELECT section_id, key, label, output_column, is_enabled FROM analysis_fields WHERE id = ?",
    ).get(added.id)).toEqual({
      section_id: sectionId,
      key: "new_result",
      label: "新结果",
      output_column: "新结果",
      is_enabled: 1,
    });
    expect(db.prepare(
      "SELECT is_enabled FROM analysis_fields WHERE id = ?",
    ).get(draft.fieldsSnapshot[0].id)).toEqual({ is_enabled: 0 });
  });

  it("reprojects the runtime field registry when activating a historical version", () => {
    const sectionId = createConfigFixture();
    const firstDraft = createDraftVersion(sectionId);
    const firstPublished = publishSectionVersion(firstDraft.id);
    const secondDraft = createDraftVersion(sectionId);
    const added = {
      ...secondDraft.fieldsSnapshot[0],
      id: `${sectionId}-historical-field`,
      key: "historical_result",
      label: "历史版本结果",
      outputColumn: "历史版本结果",
    };
    updateDraftSectionVersion(secondDraft.id, {
      fieldsSnapshot: [...secondDraft.fieldsSnapshot, added],
    });
    publishSectionVersion(secondDraft.id);

    expect(db.prepare(
      "SELECT is_enabled FROM analysis_fields WHERE id = ?",
    ).get(added.id)).toEqual({ is_enabled: 1 });

    activateSectionVersion(firstPublished.id);

    expect(db.prepare(
      "SELECT is_enabled FROM analysis_fields WHERE id = ?",
    ).get(added.id)).toEqual({ is_enabled: 0 });
    expect(db.prepare(
      "SELECT is_enabled FROM analysis_fields WHERE id = ?",
    ).get(firstDraft.fieldsSnapshot[0].id)).toEqual({ is_enabled: 1 });
    expect(createDraftVersion(sectionId).fieldsSnapshot.map((field) => field.key))
      .not.toContain("historical_result");
  });

  it("rejects changing a live field identity or reusing its key with a new field ID", () => {
    const sectionId = createConfigFixture();
    const draft = createDraftVersion(sectionId);
    expect(() => {
      updateDraftSectionVersion(draft.id, {
        fieldsSnapshot: [{
          ...draft.fieldsSnapshot[0],
          id: `${sectionId}-replacement`,
          key: draft.fieldsSnapshot[0].key,
        }],
      });
      publishSectionVersion(draft.id);
    }).toThrow("字段 Key 已被其他字段占用");

    const secondDraft = createDraftVersion(sectionId);
    expect(() => updateDraftSectionVersion(secondDraft.id, {
      fieldsSnapshot: [{
        ...secondDraft.fieldsSnapshot[0],
        key: "changed-key",
      }],
    })).toThrow("字段 Key 不可通过原字段 ID 修改");
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

  it("accepts a configurable ordinary-field collection beyond the legacy fixed limit", () => {
    const sectionId = createConfigFixture();
    const draft = createDraftVersion(sectionId);
    const fields = Array.from({ length: 201 }, (_, index) => ({
      ...draft.fieldsSnapshot[0],
      id: `${sectionId}-field-${index}`,
      key: `field_${index}`,
      label: `字段 ${index}`,
      outputColumn: `输出 ${index}`,
      sortOrder: index,
    }));
    const updated = updateDraftSectionVersion(draft.id, {
      fieldsSnapshot: fields,
      businessRules: {
        kind: "generic",
        importContract: {
          imageColumn: "聊天截图",
          requiredColumns: ["平台"],
          optionalColumns: ["客服"],
        },
      },
      dependenciesSnapshot: fields.map((field) => ({ key: field.key, dependsOn: field.dependsOn })),
    });

    expect(updated.fieldsSnapshot).toHaveLength(201);
    expect(updated.businessRules).toMatchObject({
      kind: "generic",
      importContract: {
        imageColumn: "聊天截图",
        requiredColumns: ["平台"],
        optionalColumns: ["客服"],
      },
    });
  });

  it("validates optional field input sources against the version source fields", () => {
    const sectionId = createConfigFixture();
    const draft = createDraftVersion(sectionId);
    const updated = updateDraftSectionVersion(draft.id, {
      fieldsSnapshot: [{ ...draft.fieldsSnapshot[0], inputSources: ["平台"] }],
    });
    expect(updated.fieldsSnapshot[0].inputSources).toEqual(["平台"]);

    expect(() => updateDraftSectionVersion(draft.id, {
      fieldsSnapshot: [{ ...draft.fieldsSnapshot[0], inputSources: ["不存在的输入"] }],
    })).toThrow("字段输入来源不存在");
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

    for (const field of ["name", "dimension"] as const) {
      const commaDraft = createDraftVersion("reception");
      const commaRules = structuredClone(commaDraft.businessRules) as {
        issues: Array<{ name: string; dimension: string }>;
      };
      commaRules.issues[0][field] += ",歧义";
      db.prepare("UPDATE analysis_section_versions SET business_rules_json = ? WHERE id = ?")
        .run(JSON.stringify(commaRules), commaDraft.id);
      expect(() => publishSectionVersion(commaDraft.id))
        .toThrow(field === "name" ? "问题名称不能包含英文逗号" : "问题维度不能包含英文逗号");
    }

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

    const invalidTwoStage = createDraftVersion("reception");
    const invalidTwoStageFields = structuredClone(invalidTwoStage.fieldsSnapshot);
    invalidTwoStageFields.find((field) => field.key === "截图内容总结")!.executionType = "ai";
    db.prepare("UPDATE analysis_section_versions SET fields_snapshot_json = ? WHERE id = ?")
      .run(JSON.stringify(invalidTwoStageFields), invalidTwoStage.id);
    expect(() => publishSectionVersion(invalidTwoStage.id))
      .toThrow("接待质检截图事实字段必须启用严格视觉事实抽取");
  });

  it("inherits the published reception rule catalog when creating a new draft", () => {
    const firstDraft = createDraftVersion("reception");
    const rules = structuredClone(firstDraft.businessRules) as {
      issues: Array<{ id: string; dimension: string }>;
    };
    const target = rules.issues.find((issue) => issue.id === "PRE_ANSWER_IRRELEVANT")!;
    target.dimension = "数据库沉淀维度";
    updateDraftSectionVersion(firstDraft.id, { businessRules: rules });
    publishSectionVersion(firstDraft.id);

    const nextDraft = createDraftVersion("reception");
    const inherited = nextDraft.businessRules as {
      issues: Array<{ id: string; dimension: string }>;
    };
    expect(inherited.issues.find((issue) => issue.id === target.id)?.dimension)
      .toBe("数据库沉淀维度");
  });

  it("rejects duplicate reception rule names used for result alignment", () => {
    const draft = createDraftVersion("reception");
    const rules = structuredClone(draft.businessRules) as {
      issues: Array<{ id: string; name: string }>;
    };
    rules.issues[1].name = rules.issues[0].name;
    db.prepare("UPDATE analysis_section_versions SET business_rules_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...draft.businessRules, issues: rules.issues }), draft.id);

    expect(() => publishSectionVersion(draft.id)).toThrow("接待质检问题名称重复");
  });

  it("rejects reception rules without executable criteria or evidence", () => {
    const draft = createDraftVersion("reception");
    const rules = structuredClone(draft.businessRules) as {
      issues: Array<{
        id: string;
        criterion: string;
        triggerWhen: string[];
        requiredEvidence: string[];
      }>;
    };
    rules.issues[0].criterion = " ";
    rules.issues[0].triggerWhen = [];
    rules.issues[0].requiredEvidence = [];
    db.prepare("UPDATE analysis_section_versions SET business_rules_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...draft.businessRules, issues: rules.issues }), draft.id);

    expect(() => publishSectionVersion(draft.id)).toThrow("接待质检规则缺少判定标准");
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
