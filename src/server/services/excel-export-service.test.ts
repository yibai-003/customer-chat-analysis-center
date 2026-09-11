import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, initDb } from "../db/client";
import { buildOutputPlan } from "./excel-template-service";
import { exportColumns, exportMetadataHeaders } from "./excel-export-service";

describe("Excel export columns", () => {
  beforeAll(() => initDb());
  afterEach(() => {
    db.prepare("DELETE FROM analysis_fields WHERE section_id = 'task-5-export'").run();
    db.prepare("DELETE FROM analysis_sections WHERE id = 'task-5-export'").run();
  });

  it("does not add runtime status metadata columns to exported workbooks", () => {
    expect(exportMetadataHeaders()).toEqual([]);
  });

  it("uses field labels in exported headers", () => {
    const columns = exportColumns([{
      id: "reception", name: "接待流程质检", parentId: "chat", prompt: "",
      outputSchema: [], sortOrder: 1, isEnabled: true, imageEnabled: true,
    }]);
    expect(columns.map((column) => column.header)).toContain("接待流程质检_质检结论");
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
