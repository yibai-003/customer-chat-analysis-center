import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, initDb } from "../db/client";
import { createFieldRun } from "./field-run-service";
import { exportJob } from "./excel-export-service";
import { getSectionVersion } from "./section-config-version-service";
import type { ReceptionQualityAnalysis } from "./reception-quality";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZK1sAAAAASUVORK5CYII=",
  "base64",
);

function qualityIssue(
  issueId: string,
  chatQuotes: string[],
  evidenceExplanation: string,
  reason: string,
) {
  return {
    issueId,
    chatQuotes,
    evidenceIds: ["T1"],
    evidenceExplanation,
    reason,
    name: "",
    dimension: "",
    deduction: 0,
    forceD: false,
    violationCount: 1,
    suggestion: "",
  };
}

function multiIssueQuality(): ReceptionQualityAnalysis {
  return {
    analysisProtocol: "strict",
    scene: "售前",
    checkedRuleIds: ["PRE_PASSIVE_SERVICE", "PRE_ANSWER_IRRELEVANT"],
    preSaleIssues: [
      qualityIssue(
        "PRE_ANSWER_IRRELEVANT",
        ["客户问尺码", "客服说天气不错"],
        "客服回复没有回应尺码问题",
        "命中答非所问规则",
      ),
      qualityIssue(
        "PRE_PASSIVE_SERVICE",
        ["客服说天气不错", "客服拒绝处理"],
        "客服明确拒绝继续接待",
        "命中服务消极规则",
      ),
    ],
    afterSaleIssues: [],
    unverifiableItems: [],
    informationalUnverifiableItems: [],
    suggestion: "",
    confidence: 0.95,
    score: 85,
    totalDeduction: 15,
    grade: "D",
    hasDLevelIssue: true,
    hasAfterSaleViolation: false,
    labels: ["服务消极D级", "答非所问"],
    dimensions: ["服务态度", "问题解决"],
    deductions: [5, 10],
    conversationStartTime: "2026-09-23 09:30:00",
    conversationRoundCount: 2,
    reviewRequired: false,
  };
}

function noIssueQuality(): ReceptionQualityAnalysis {
  return {
    analysisProtocol: "strict",
    scene: "售前",
    checkedRuleIds: [],
    preSaleIssues: [],
    afterSaleIssues: [],
    unverifiableItems: [],
    informationalUnverifiableItems: [],
    suggestion: "",
    confidence: 0.99,
    score: 100,
    totalDeduction: 0,
    grade: "A",
    hasDLevelIssue: false,
    hasAfterSaleViolation: false,
    labels: [],
    dimensions: [],
    deductions: [],
    conversationStartTime: "2026-09-23 10:00:00",
    conversationRoundCount: 1,
    reviewRequired: false,
  };
}

function columnFor(sheet: ExcelJS.Worksheet, header: string) {
  const values = sheet.getRow(1).values as unknown[];
  return values.findIndex((value) => String(value ?? "") === header);
}

describe("reception screenshot-row export contract", () => {
  const jobIds = new Set<string>();
  const files = new Set<string>();

  beforeAll(() => initDb());
  afterEach(() => {
    for (const jobId of jobIds) {
      db.prepare("DELETE FROM analysis_field_runs WHERE record_id IN (SELECT id FROM records WHERE job_id = ?)").run(jobId);
      db.prepare("DELETE FROM record_section_reviews WHERE record_id IN (SELECT id FROM records WHERE job_id = ?)").run(jobId);
      db.prepare("DELETE FROM records WHERE job_id = ?").run(jobId);
      db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
    }
    for (const file of files) fs.rmSync(file, { force: true });
    jobIds.clear();
    files.clear();
  });

  async function createFixture(
    firstQuality: ReceptionQualityAnalysis = multiIssueQuality(),
    secondQuality: ReceptionQualityAnalysis = noIssueQuality(),
  ) {
    const suffix = crypto.randomUUID();
    const sourcePath = path.join(os.tmpdir(), `reception-row-export-${suffix}.xlsx`);
    const source = new ExcelJS.Workbook();
    const sheet = source.addWorksheet("接待明细");
    sheet.addRow(["平台", "订单号", "聊天截图", "问题", "保留公式", "原始备注"]);
    sheet.addRow(["源平台", "A-1", "", "旧问题", "", "不能改变"]);
    sheet.addRow(["预留平台", "预留行", "", "预留问题", "", "预留备注"]);
    sheet.addRow(["源平台", "A-2", "", "", "", "合规会话"]);
    sheet.getCell("A2").fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFFFF00" },
    };
    sheet.getCell("E2").value = { formula: "LEN(B2)", result: 3 };
    sheet.getCell("E3").value = { formula: "LEN(B3)", result: 3 };
    const imageId = source.addImage({ buffer: png as any, extension: "png" });
    sheet.addImage(imageId, {
      tl: { col: 2, row: 1 },
      ext: { width: 30, height: 20 },
      editAs: "oneCell",
    });
    sheet.addImage(imageId, {
      tl: { col: 2, row: 3 },
      ext: { width: 30, height: 20 },
      editAs: "oneCell",
    });
    await source.xlsx.writeFile(sourcePath);
    files.add(sourcePath);

    const current = db.prepare(`
      SELECT id FROM analysis_section_versions
      WHERE section_id = 'reception' AND is_current = 1
    `).get() as { id: string };
    const version = getSectionVersion(current.id)!;
    const qualityField = version.fieldsSnapshot.find((field) => field.key === "统一质检分析")!;
    const jobId = `reception-export-${suffix}`;
    const timestamp = "2026-09-23T00:00:00.000Z";
    db.prepare(`
      INSERT INTO jobs (
        id, original_filename, source_path, section_id, section_name,
        section_config_version_id, platform_name, status,
        total_records, completed_records, failed_records, created_at, updated_at
      ) VALUES (?, '接待.xlsx', ?, 'reception', '接待流程质检', ?, '抖音',
        'completed', 2, 2, 0, ?, ?)
    `).run(jobId, sourcePath, version.id, timestamp, timestamp);
    const insertRecord = db.prepare(`
      INSERT INTO records (
        id, job_id, sheet_name, row_number, anchor_json, source_fields_json,
        image_path, conversation_id, conversation_id_assigned_at,
        status, review_status, review_note, created_at, updated_at
      ) VALUES (?, ?, '接待明细', ?, '{}', '{}', ?, ?, ?, 'completed', 'pending', '', ?, ?)
    `);
    const firstRecordId = `reception-record-a-${suffix}`;
    const secondRecordId = `reception-record-b-${suffix}`;
    insertRecord.run(
      firstRecordId,
      jobId,
      2,
      "screenshot-a.png",
      `DY20260923A${suffix.slice(0, 5).toUpperCase()}`,
      timestamp,
      timestamp,
      timestamp,
    );
    insertRecord.run(
      secondRecordId,
      jobId,
      4,
      "screenshot-b.png",
      `DY20260923B${suffix.slice(0, 5).toUpperCase()}`,
      timestamp,
      timestamp,
      timestamp,
    );
    createFieldRun({
      recordId: firstRecordId,
      fieldId: qualityField.id,
      fieldSnapshot: qualityField,
      status: "completed",
      result: { 统一质检分析: firstQuality },
    });
    createFieldRun({
      recordId: secondRecordId,
      fieldId: qualityField.id,
      fieldSnapshot: qualityField,
      status: "completed",
      result: { 统一质检分析: secondQuality },
    });
    jobIds.add(jobId);
    return { jobId, sourcePath, firstRecordId };
  }

  it("aggregates issues in screenshot rows and preserves workbook structure", async () => {
    const fixture = await createFixture();
    const outputPath = await exportJob(fixture.jobId);
    files.add(outputPath);
    const exported = new ExcelJS.Workbook();
    await exported.xlsx.readFile(outputPath);
    const sheet = exported.getWorksheet("接待明细")!;

    expect(exported.worksheets.map((item) => item.name)).toEqual(["接待明细"]);
    expect(sheet.rowCount).toBe(4);
    expect(sheet.getImages()).toHaveLength(2);
    expect(sheet.getImages().map((image) =>
      Number((image.range as any).tl.nativeRow ?? (image.range as any).tl.row) + 1))
      .toEqual([2, 4]);
    expect(sheet.getCell("A2").fill).toMatchObject({
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFFFF00" },
    });
    expect(sheet.getCell("E2").value).toMatchObject({ formula: "LEN(B2)" });
    expect(sheet.getCell("E3").value).toMatchObject({ formula: "LEN(B3)" });
    expect(sheet.getCell("F2").value).toBe("不能改变");

    const problemColumn = columnFor(sheet, "问题");
    expect((sheet.getRow(1).values as unknown[]).filter((value) => value === "问题")).toHaveLength(1);
    expect(problemColumn).toBe(4);
    expect(sheet.getRow(2).getCell(columnFor(sheet, "平台")).value).toBe("抖音");
    expect(sheet.getRow(2).getCell(columnFor(sheet, "会话ID")).value).toContain("DY20260923A");
    expect(sheet.getRow(2).getCell(problemColumn).value).toBe("服务消极D级/答非所问");
    expect(sheet.getRow(2).getCell(columnFor(sheet, "维度")).value).toBe("服务态度/问题解决");
    expect(sheet.getRow(2).getCell(columnFor(sheet, "扣分")).value).toBe("5/10");
    expect(sheet.getRow(2).getCell(columnFor(sheet, "合计扣分")).value).toBe(15);
    expect(sheet.getRow(2).getCell(columnFor(sheet, "是否D级")).value).toBe("是");
    expect(sheet.getRow(2).getCell(columnFor(sheet, "聊天原文")).value)
      .toBe("客服说天气不错；客服拒绝处理/客户问尺码；客服说天气不错");
    expect(sheet.getRow(2).getCell(columnFor(sheet, "证据说明")).value)
      .toBe("客服明确拒绝继续接待/客服回复没有回应尺码问题");
    expect(sheet.getRow(2).getCell(columnFor(sheet, "判定理由")).value)
      .toBe("命中服务消极规则/命中答非所问规则");
    expect(sheet.getRow(2).getCell(columnFor(sheet, "优化建议")).value)
      .toBe("1. 承接客户诉求并明确下一步处理动作，避免推诿。\n2. 先直接回答客户核心问题，再补充相关说明。");
    expect(sheet.getRow(2).getCell(columnFor(sheet, "接待流程质检结果")).value).toBe("D");
    expect(sheet.getRow(2).getCell(columnFor(sheet, "是否待人工复核")).value).toBe("否");
    expect(sheet.getRow(2).getCell(columnFor(sheet, "会话开始时间")).value)
      .toBe("2026-09-23 09:30:00");
    expect(sheet.getRow(2).getCell(columnFor(sheet, "对话轮数")).value).toBe(2);

    expect(sheet.getRow(3).getCell(columnFor(sheet, "平台")).value).toBe("预留平台");
    expect(sheet.getRow(3).getCell(problemColumn).value).toBe("预留问题");
    expect(sheet.getRow(3).getCell(columnFor(sheet, "会话ID")).value).toBeNull();
    expect(sheet.getRow(4).getCell(problemColumn).value).toBe("");
    expect(sheet.getRow(4).getCell(columnFor(sheet, "维度")).value).toBe("");
    expect(sheet.getRow(4).getCell(columnFor(sheet, "扣分")).value).toBe("");
    expect(sheet.getRow(4).getCell(columnFor(sheet, "是否D级")).value).toBe("");
    expect(sheet.getRow(4).getCell(columnFor(sheet, "聊天原文")).value).toBe("");
    expect(sheet.getRow(4).getCell(columnFor(sheet, "证据说明")).value).toBe("");
    expect(sheet.getRow(4).getCell(columnFor(sheet, "判定理由")).value).toBe("");
    expect(sheet.getRow(4).getCell(columnFor(sheet, "优化建议")).value).toBe("");
    expect(sheet.getRow(4).getCell(columnFor(sheet, "合计扣分")).value).toBe(0);
    expect(sheet.getRow(4).getCell(columnFor(sheet, "接待流程质检结果")).value).toBe("A");
    expect(sheet.getRow(4).getCell(columnFor(sheet, "是否待人工复核")).value).toBe("否");
  });

  it("preserves missing issue values as blank slots and marks the export for review", async () => {
    const invalid = multiIssueQuality();
    invalid.dimensions = ["服务态度"];
    const fixture = await createFixture(invalid);
    const outputPath = await exportJob(fixture.jobId);
    files.add(outputPath);
    const exported = new ExcelJS.Workbook();
    await exported.xlsx.readFile(outputPath);
    const sheet = exported.getWorksheet("接待明细")!;

    expect(sheet.getRow(2).getCell(columnFor(sheet, "维度")).value).toBe("服务态度/");
    expect(sheet.getRow(2).getCell(columnFor(sheet, "是否待人工复核")).value).toBe("是");
  });

  it("blocks cells over the Excel limit without truncating", async () => {
    const invalid = multiIssueQuality();
    invalid.preSaleIssues[0].evidenceExplanation = "证".repeat(32_768);
    const fixture = await createFixture(invalid);
    await expect(exportJob(fixture.jobId)).rejects.toThrow(
      "Excel 单元格内容超过 32767 字符：接待明细 第 2 行，字段“证据说明”",
    );
  });
});
