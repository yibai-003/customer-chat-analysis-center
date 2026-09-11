import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, initDb } from "../../db/client";
import { extractKnowledgeValue } from "./knowledge-extract-service";

describe("knowledge extract service", () => {
  beforeAll(() => initDb());
  beforeEach(() => {
    db.exec(`
      DELETE FROM knowledge_match_snapshots;
      DELETE FROM analysis_field_runs;
      DELETE FROM records;
      DELETE FROM jobs;
      DELETE FROM analysis_fields WHERE section_id IN ('task-5-extract', 'task-5-other');
      DELETE FROM analysis_sections WHERE id IN ('task-5-extract', 'task-5-other');
    `);
    const timestamp = "2026-09-09T00:00:00.000Z";
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES (?, NULL, ?, '', '[]', '[]', 99, 1, 0, ?, ?)
    `).run("task-5-extract", "提取测试", timestamp, timestamp);
    db.prepare(`
      INSERT INTO analysis_fields (
        id, section_id, key, label, field_type, prompt, options_json,
        is_required, image_enabled, depends_on_json, sort_order, execution_type,
        export_enabled, candidate_limit, is_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'string', '', '[]', 0, 0, '[]', 0, 'knowledge_match', 1, 15, 1, ?, ?)
    `).run("task-5-match-field", "task-5-extract", "reasonMatch", "原因匹配", timestamp, timestamp);
    db.prepare(`
      INSERT INTO jobs (
        id, original_filename, source_path, status, total_records,
        completed_records, failed_records, created_at, updated_at
      ) VALUES (?, 'source.xlsx', 'source.xlsx', 'processing', 1, 0, 0, ?, ?)
    `).run("task-5-extract-job", timestamp, timestamp);
    db.prepare(`
      INSERT INTO records (
        id, job_id, sheet_name, row_number, anchor_json, source_fields_json,
        image_path, status, review_status, review_note, created_at, updated_at
      ) VALUES (?, ?, 'Sheet1', 2, '{}', '{}', '', 'processing', 'pending', '', ?, ?)
    `).run("task-5-extract-record", "task-5-extract-job", timestamp, timestamp);
    db.prepare(`
      INSERT INTO knowledge_match_snapshots (
        id, record_id, field_id, knowledge_base_id, knowledge_item_id,
        item_values_json, candidate_snapshot_json, query_snapshot,
        model_response, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, '[]', '{}', '{}', ?)
    `).run(
      "task-5-snapshot",
      "task-5-extract-record",
      "task-5-match-field",
      "deleted-base",
      "deleted-item",
      JSON.stringify({
        一级原因: "品质",
        二级原因: "结构",
        三级原因: "面板弹簧片脱落",
      }),
      timestamp,
    );
  });

  it("extracts multiple columns from the immutable match snapshot", () => {
    expect(extractKnowledgeValue({
      recordId: "task-5-extract-record",
      sectionId: "task-5-extract",
      matchFieldKey: "reasonMatch",
      matchValue: "deleted-item",
      knowledgeColumn: "一级原因",
      outputKey: "level1",
    })).toEqual({ level1: "品质" });
    expect(extractKnowledgeValue({
      recordId: "task-5-extract-record",
      sectionId: "task-5-extract",
      matchFieldKey: "reasonMatch",
      matchValue: "deleted-item",
      knowledgeColumn: "二级原因",
      outputKey: "level2",
    })).toEqual({ level2: "结构" });
    expect(extractKnowledgeValue({
      recordId: "task-5-extract-record",
      sectionId: "task-5-extract",
      matchFieldKey: "reasonMatch",
      matchValue: "deleted-item",
      knowledgeColumn: "三级原因",
      outputKey: "level3",
    })).toEqual({ level3: "面板弹簧片脱落" });
  });

  it("returns an empty value when the snapshot or selected column is absent", () => {
    expect(extractKnowledgeValue({
      recordId: "task-5-extract-record",
      sectionId: "task-5-extract",
      matchFieldKey: "reasonMatch",
      matchValue: "deleted-item",
      knowledgeColumn: "不存在",
      outputKey: "missingColumn",
    })).toEqual({ missingColumn: "" });
    expect(extractKnowledgeValue({
      recordId: "task-5-extract-record",
      sectionId: "task-5-extract",
      matchFieldKey: "unknownMatch",
      matchValue: "deleted-item",
      knowledgeColumn: "一级原因",
      outputKey: "missingSnapshot",
    })).toEqual({ missingSnapshot: "" });
  });

  it("returns an empty value when the current match does not point to the saved snapshot", () => {
    expect(extractKnowledgeValue({
      recordId: "task-5-extract-record",
      sectionId: "task-5-extract",
      matchFieldKey: "reasonMatch",
      matchValue: "",
      knowledgeColumn: "一级原因",
      outputKey: "staleMatch",
    })).toEqual({ staleMatch: "" });
    expect(extractKnowledgeValue({
      recordId: "task-5-extract-record",
      sectionId: "task-5-extract",
      matchFieldKey: "reasonMatch",
      matchValue: "different-item",
      knowledgeColumn: "一级原因",
      outputKey: "differentMatch",
    })).toEqual({ differentMatch: "" });
  });

  it("does not use a newer snapshot from another section with the same match key", () => {
    const timestamp = "2026-09-09T00:01:00.000Z";
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES (?, NULL, ?, '', '[]', '[]', 100, 1, 0, ?, ?)
    `).run("task-5-other", "其他板块", timestamp, timestamp);
    db.prepare(`
      INSERT INTO analysis_fields (
        id, section_id, key, label, field_type, prompt, options_json,
        is_required, image_enabled, depends_on_json, sort_order, execution_type,
        export_enabled, candidate_limit, is_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'string', '', '[]', 0, 0, '[]', 0, 'knowledge_match', 0, 15, 1, ?, ?)
    `).run("task-5-other-match", "task-5-other", "reasonMatch", "其他原因匹配", timestamp, timestamp);
    db.prepare(`
      INSERT INTO knowledge_match_snapshots (
        id, record_id, field_id, knowledge_base_id, knowledge_item_id,
        item_values_json, candidate_snapshot_json, query_snapshot,
        model_response, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, '[]', '{}', '{}', ?)
    `).run(
      "task-5-other-snapshot",
      "task-5-extract-record",
      "task-5-other-match",
      "other-base",
      "other-item",
      JSON.stringify({ 一级原因: "错误板块值" }),
      timestamp,
    );

    expect(extractKnowledgeValue({
      recordId: "task-5-extract-record",
      sectionId: "task-5-extract",
      matchFieldKey: "reasonMatch",
      matchValue: "deleted-item",
      knowledgeColumn: "一级原因",
      outputKey: "level1",
    })).toEqual({ level1: "品质" });
  });
});
