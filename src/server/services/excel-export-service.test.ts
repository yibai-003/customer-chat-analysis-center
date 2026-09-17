import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, initDb } from "../db/client";
import { config } from "../config";
import { buildOutputPlan } from "./excel-template-service";
import { exportColumns, exportJob, exportMetadataHeaders } from "./excel-export-service";
import { createFieldRun } from "./field-run-service";

function worksheetValues(workbook: ExcelJS.Workbook, sheetName: string) {
  const sheet = workbook.getWorksheet(sheetName)!;
  const headers = (sheet.getRow(1).values as unknown[])
    .map((value) => String(value ?? "")).filter(Boolean);
  const cells = Object.fromEntries(headers.map((header, index) => [
    header,
    String(sheet.getRow(2).getCell(index + 1).value ?? ""),
  ]));
  return { headers, cells };
}

describe("Excel export columns", () => {
  const generatedFiles = new Set<string>();
  beforeAll(() => initDb());
  afterEach(() => {
    db.prepare("DELETE FROM analysis_field_runs WHERE record_id IN (SELECT id FROM records WHERE job_id = 'task-5-export-job')").run();
    db.prepare("DELETE FROM records WHERE job_id = 'task-5-export-job'").run();
    db.prepare("DELETE FROM jobs WHERE id = 'task-5-export-job'").run();
    db.prepare("DELETE FROM analysis_fields WHERE section_id = 'task-5-export'").run();
    db.prepare("DELETE FROM analysis_sections WHERE id = 'task-5-export'").run();
    for (const file of generatedFiles) fs.rmSync(file, { force: true });
    generatedFiles.clear();
  });

  it("does not add runtime status metadata columns to exported workbooks", () => {
    expect(exportMetadataHeaders()).toEqual([]);
  });

  it("uses field labels in exported headers", () => {
    const columns = exportColumns([{
      id: "reception", name: "接待流程质检", parentId: "chat", prompt: "",
      outputSchema: [], sortOrder: 1, isEnabled: true, imageEnabled: true,
    }]);
    expect(columns.map((column) => column.header)).toEqual(expect.arrayContaining([
      "接待流程质检_问题点-售前",
      "接待流程质检_问题点-售后",
      "接待流程质检_接待流程质检结果",
    ]));
  });

  it("preserves lost-deal public headers without exporting internal attribution", () => {
    const columns = exportColumns([{
      id: "lost-deal", name: "未成交分析", parentId: "chat", prompt: "",
      outputSchema: [], sortOrder: 3, isEnabled: true, imageEnabled: true,
    }]);
    const headers = columns.map((column) => column.header);
    for (const header of ["未成交分析_客户原因", "未成交分析_客服原因", "未成交分析_客户产品需求", "未成交分析_话术逻辑优化建议"]) {
      expect(headers).toContain(header);
    }
    expect(headers).not.toContain("未成交分析_未成交归因");
  });

  it("reuses public lost-deal headers in a real exported workbook and omits internal attribution", async () => {
    const sourcePath = path.join(os.tmpdir(), `lost-deal-export-${Date.now()}.xlsx`);
    generatedFiles.add(sourcePath);
    const source = new ExcelJS.Workbook();
    const sheet = source.addWorksheet("Sheet1");
    sheet.addRow(["订单号", "客户原因", "客服原因", "客户产品需求", "话术逻辑优化建议"]);
    sheet.addRow(["A-1", "", "", "", ""]);
    await source.xlsx.writeFile(sourcePath);
    const timestamp = "2026-09-16T00:00:00.000Z";
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES ('task-5-export', NULL, '未成交分析', '', '[]', '[]', 99, 1, 1, ?, ?)
    `).run(timestamp, timestamp);
    const insertField = db.prepare(`
      INSERT INTO analysis_fields (
        id, section_id, key, label, field_type, prompt, options_json, output_column,
        is_required, image_enabled, depends_on_json, sort_order, execution_type,
        export_enabled, candidate_limit, is_enabled, created_at, updated_at
      ) VALUES (?, 'task-5-export', ?, ?, ?, '', '[]', ?, 0, 0, '[]', ?, ?, ?, 15, 1, ?, ?)
    `);
    for (const [index, key] of [
      "客户原因", "客服原因", "客户产品需求", "话术逻辑优化建议",
    ].entries()) {
      insertField.run(`task-5-export-${index}`, key, key, "string", key, index, "lost_deal_derive", 1, timestamp, timestamp);
    }
    insertField.run(
      "task-5-export-internal", "未成交归因", "未成交归因", "object", null, 4,
      "lost_deal_attribution", 0, timestamp, timestamp,
    );
    db.prepare(`
      INSERT INTO jobs (
        id, original_filename, source_path, section_id, section_name, status,
        total_records, completed_records, failed_records, created_at, updated_at
      ) VALUES ('task-5-export-job', 'source.xlsx', ?, 'task-5-export', '未成交分析',
        'ready', 1, 0, 0, ?, ?)
    `).run(sourcePath, timestamp, timestamp);
    db.prepare(`
      INSERT INTO records (
        id, job_id, sheet_name, row_number, anchor_json, source_fields_json,
        image_path, status, review_status, review_note, created_at, updated_at
      ) VALUES ('task-5-export-record', 'task-5-export-job', 'Sheet1', 2, '{}', '{}',
        '', 'completed', 'pending', '', ?, ?)
    `).run(timestamp, timestamp);
    createFieldRun({
      recordId: "task-5-export-record",
      fieldId: "task-5-export-0",
      status: "completed",
      result: { 客户原因: "价格超出预算" },
    });
    createFieldRun({
      recordId: "task-5-export-record",
      fieldId: "task-5-export-1",
      status: "completed",
      result: { 客服原因: "优惠说明不清晰" },
    });
    createFieldRun({
      recordId: "task-5-export-record",
      fieldId: "task-5-export-2",
      status: "completed",
      result: { 客户产品需求: "" },
    });
    createFieldRun({
      recordId: "task-5-export-record",
      fieldId: "task-5-export-3",
      status: "completed",
      result: { 话术逻辑优化建议: "先确认客户预算，再清晰说明到手价和优惠条件，并确认该方案是否可接受。" },
    });
    createFieldRun({
      recordId: "task-5-export-record",
      fieldId: "task-5-export-internal",
      status: "needs_review",
      result: {
        未成交归因: {
          specificDemand: "希望优惠到100元",
          specificDemandGrounded: false,
          reviewRequired: true,
        },
      },
    });

    const outputPath = await exportJob("task-5-export-job", ["task-5-export"]);
    generatedFiles.add(outputPath);
    expect(outputPath).toBe(path.join(config.dataDir, "exports", "task-5-export-job-客服解析结果.xlsx"));
    const exported = new ExcelJS.Workbook();
    await exported.xlsx.readFile(outputPath);
    const { headers, cells } = worksheetValues(exported, "Sheet1");
    for (const header of ["客户原因", "客服原因", "客户产品需求", "话术逻辑优化建议"]) {
      expect(headers.filter((item) => item === header)).toHaveLength(1);
    }
    expect(headers).not.toContain("未成交归因");
    expect(cells).toMatchObject({
      订单号: "A-1",
      客户原因: "价格超出预算",
      客服原因: "优惠说明不清晰",
      客户产品需求: "",
      话术逻辑优化建议: "先确认客户预算，再清晰说明到手价和优惠条件，并确认该方案是否可接受。",
    });
    expect(JSON.stringify(cells)).not.toContain("希望优惠到100元");
  });

  it("reuses public reception headers in a real exported workbook and omits internal quality fields", async () => {
    const sourcePath = path.join(os.tmpdir(), `reception-export-${Date.now()}.xlsx`);
    generatedFiles.add(sourcePath);
    const source = new ExcelJS.Workbook();
    const sheet = source.addWorksheet("Sheet1");
    sheet.addRow(["订单号", "问题点-售前", "问题点-售后", "有无违规-售后", "客服问题 识别问题并打标签", "接待流程质检结果", "优化建议-售前"]);
    sheet.addRow(["B-1", "", "", "", "", "", ""]);
    await source.xlsx.writeFile(sourcePath);
    const timestamp = "2026-09-16T00:00:00.000Z";
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES ('task-5-export', NULL, '接待流程质检', '', '[]', '[]', 99, 1, 1, ?, ?)
    `).run(timestamp, timestamp);
    const insertField = db.prepare(`
      INSERT INTO analysis_fields (
        id, section_id, key, label, field_type, prompt, options_json, output_column,
        is_required, image_enabled, depends_on_json, sort_order, execution_type,
        export_enabled, candidate_limit, is_enabled, created_at, updated_at
      ) VALUES (?, 'task-5-export', ?, ?, ?, '', '[]', ?, 0, 0, '[]', ?, ?, ?, 15, 1, ?, ?)
    `);
    insertField.run("task-5-export-facts", "截图内容总结", "截图内容总结", "object", "截图内容总结", 0, "ai", 0, timestamp, timestamp);
    insertField.run("task-5-export-quality", "统一质检分析", "统一质检分析", "object", "统一质检分析", 1, "reception_quality_analysis", 0, timestamp, timestamp);
    const publicFields = [
      ["问题点-售前", "问题点-售前"],
      ["问题点-售后", "问题点-售后"],
      ["有无违规-售后", "有无违规-售后"],
      ["客服问题识别问题并打标签", "客服问题 识别问题并打标签"],
      ["接待流程质检结果", "接待流程质检结果"],
      ["优化建议-售前", "优化建议-售前"],
    ];
    for (const [index, [key, column]] of publicFields.entries()) {
      insertField.run(`task-5-export-${index}`, key, key, "string", column, index + 2, "reception_quality_derive", 1, timestamp, timestamp);
    }
    db.prepare(`
      INSERT INTO jobs (
        id, original_filename, source_path, section_id, section_name, status,
        total_records, completed_records, failed_records, created_at, updated_at
      ) VALUES ('task-5-export-job', 'source.xlsx', ?, 'task-5-export', '接待流程质检',
        'ready', 1, 0, 0, ?, ?)
    `).run(sourcePath, timestamp, timestamp);
    db.prepare(`
      INSERT INTO records (
        id, job_id, sheet_name, row_number, anchor_json, source_fields_json,
        image_path, status, review_status, review_note, created_at, updated_at
      ) VALUES ('task-5-export-record', 'task-5-export-job', 'Sheet1', 2, '{}', '{}',
        '', 'completed', 'pending', '', ?, ?)
    `).run(timestamp, timestamp);
    createFieldRun({
      recordId: "task-5-export-record",
      fieldId: "task-5-export-facts",
      status: "completed",
      result: { 截图内容总结: { dialogueTurns: [{ id: "T1", text: "内部事实不得导出" }] } },
    });
    createFieldRun({
      recordId: "task-5-export-record",
      fieldId: "task-5-export-quality",
      status: "completed",
      result: { 统一质检分析: { scene: "混合", grade: "B", labels: ["答非所问"] } },
    });
    createFieldRun({
      recordId: "task-5-export-record",
      fieldId: "task-5-export-0",
      status: "completed",
      result: { "问题点-售前": "1. 答非所问" },
    });
    createFieldRun({
      recordId: "task-5-export-record",
      fieldId: "task-5-export-1",
      status: "completed",
      result: { "问题点-售后": "1. 漏回复" },
    });
    createFieldRun({
      recordId: "task-5-export-record",
      fieldId: "task-5-export-2",
      status: "completed",
      result: { "有无违规-售后": "有违规" },
    });
    createFieldRun({
      recordId: "task-5-export-record",
      fieldId: "task-5-export-3",
      status: "completed",
      result: { 客服问题识别问题并打标签: "答非所问、漏回复" },
    });
    createFieldRun({
      recordId: "task-5-export-record",
      fieldId: "task-5-export-4",
      status: "completed",
      result: { 接待流程质检结果: "B" },
    });
    createFieldRun({
      recordId: "task-5-export-record",
      fieldId: "task-5-export-5",
      status: "completed",
      result: { "优化建议-售前": "先准确回答尺寸" },
    });

    const outputPath = await exportJob("task-5-export-job", ["task-5-export"]);
    generatedFiles.add(outputPath);
    const exported = new ExcelJS.Workbook();
    await exported.xlsx.readFile(outputPath);
    const { headers, cells } = worksheetValues(exported, "Sheet1");
    expect(headers).toEqual([
      "订单号", "问题点-售前", "问题点-售后", "有无违规-售后",
      "客服问题 识别问题并打标签", "接待流程质检结果", "优化建议-售前",
    ]);
    expect(headers).not.toContain("截图内容总结");
    expect(headers).not.toContain("统一质检分析");
    expect(cells).toMatchObject({
      订单号: "B-1",
      "问题点-售前": "1. 答非所问",
      "问题点-售后": "1. 漏回复",
      "有无违规-售后": "有违规",
      "客服问题 识别问题并打标签": "答非所问、漏回复",
      接待流程质检结果: "B",
      "优化建议-售前": "先准确回答尺寸",
    });
    expect(JSON.stringify(cells)).not.toContain("内部事实不得导出");
    expect(JSON.stringify(cells)).not.toContain("统一质检分析");
  });

  it("omits fields disabled for export from column and output plans", () => {
    const timestamp = "2026-09-09T00:00:00.000Z";
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES (?, NULL, ?, '', '[]', '[]', 99, 1, 0, ?, ?)
    `).run("task-5-export", "导出测试", timestamp, timestamp);
    const insert = db.prepare(`
      INSERT INTO analysis_fields (
        id, section_id, key, label, field_type, prompt, options_json,
        is_required, image_enabled, depends_on_json, sort_order, execution_type,
        export_enabled, candidate_limit, is_enabled, created_at, updated_at
      ) VALUES (?, 'task-5-export', ?, ?, 'string', '', '[]', 0, 0, '[]', ?, 'ai', ?, 15, 1, ?, ?)
    `);
    insert.run("task-5-public", "publicResult", "公开结果", 0, 1, timestamp, timestamp);
    insert.run("task-5-internal", "internalMatch", "内部匹配", 1, 0, timestamp, timestamp);

    const sections = [{
      id: "task-5-export", name: "导出测试", parentId: null, prompt: "",
      outputSchema: [], sortOrder: 99, isEnabled: true, imageEnabled: false,
    }];
    expect(exportColumns(sections)).toEqual([
      { key: "publicResult", header: "导出测试_公开结果" },
    ]);
    expect(buildOutputPlan([], [
      { key: "publicResult", label: "公开结果", exportEnabled: true },
      { key: "internalMatch", label: "内部匹配", exportEnabled: false },
    ])).toEqual([
      { key: "publicResult", column: 1, header: "公开结果" },
    ]);
  });
});
