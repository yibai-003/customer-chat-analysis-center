import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, initDb } from "../../db/client";
import { analyzeRecordFields } from "../field-analysis-service";
import { createStructuredAnalysisHandler, createStructuredDeriveHandler, type StructuredFieldDefinition } from "./structured";
import { registerFieldExecutionHandler } from "./registry";
import "./index";

vi.mock("../model-pool-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model-pool-service")>();
  return { ...actual, callModelPool: vi.fn() };
});

import { callModelPool } from "../model-pool-service";
import type { AnalysisExecutionType } from "../../../shared/types";

interface ProbeParsed {
  conclusion: string;
  evidence: string[];
}

const probeRules = {
  publicFields(parsed: ProbeParsed) {
    return {
      探针结论: parsed.conclusion,
      探针依据: parsed.evidence.join(" | "),
    };
  },
};

const probeDefinition: StructuredFieldDefinition<{ note: string }, ProbeParsed> = {
  key: "探针归因",
  prepare({ dependencies }) {
    return { note: typeof dependencies["备注"] === "string" ? dependencies["备注"] as string : "" };
  },
  buildMessages(input, source) {
    return [{ role: "user", content: `probe:${source.note}:${input.field.key}` }];
  },
  parse(raw) {
    const parsed = JSON.parse(raw) as { conclusion?: unknown; evidence?: unknown };
    if (typeof parsed.conclusion !== "string" || !Array.isArray(parsed.evidence)) {
      throw new Error("探针 JSON 无效");
    }
    return { conclusion: parsed.conclusion, evidence: parsed.evidence.map(String) };
  },
  derive: (parsed) => probeRules.publicFields(parsed),
  status: (parsed) => parsed.evidence.length
    ? { status: "completed" }
    : { status: "needs_review", errorMessage: "探针缺少证据" },
  evidence: (parsed) => parsed.evidence.join("\n"),
};

registerFieldExecutionHandler(createStructuredAnalysisHandler(
  "probe_structured_analysis" as AnalysisExecutionType,
  probeDefinition,
));
registerFieldExecutionHandler(createStructuredDeriveHandler(
  "probe_structured_derive" as AnalysisExecutionType,
  probeDefinition,
  { modelConfigSnapshot: { strategy: "local_rules" } },
));

const timestamp = "2026-09-17T00:00:00.000Z";

function routedResponse(content: string) {
  return {
    content,
    raw: "{}",
    usage: {},
    model: { id: "probe-model", name: "探针模型", model: "probe-model", purpose: "text" },
    attempts: [{ modelConfigId: "probe-model", model: "probe-model", status: "success", durationMs: 1 }],
  } as Awaited<ReturnType<typeof callModelPool>>;
}

describe("structured field abstraction probe", () => {
  beforeAll(() => initDb());

  beforeEach(() => {
    vi.mocked(callModelPool).mockReset();
    db.exec(`
      DELETE FROM analysis_field_runs;
      DELETE FROM records;
      DELETE FROM jobs;
      DELETE FROM analysis_fields WHERE section_id = 'probe-board';
      DELETE FROM analysis_sections WHERE id = 'probe-board';
    `);
    db.prepare(`
      INSERT INTO analysis_sections (
        id, parent_id, name, prompt, output_schema_json, source_fields_json,
        sort_order, is_enabled, image_enabled, created_at, updated_at
      ) VALUES ('probe-board', NULL, '探针板块', '', '[]', '["备注"]', 99, 1, 0, ?, ?)
    `).run(timestamp, timestamp);
    db.prepare(`
      INSERT INTO jobs (
        id, original_filename, source_path, status, total_records,
        completed_records, failed_records, created_at, updated_at
      ) VALUES ('probe-job', 'probe.xlsx', 'probe.xlsx', 'ready', 1, 0, 0, ?, ?)
    `).run(timestamp, timestamp);
    db.prepare(`
      INSERT INTO records (
        id, job_id, sheet_name, row_number, anchor_json, source_fields_json,
        image_path, status, review_status, review_note, created_at, updated_at
      ) VALUES ('probe-record', 'probe-job', 'Sheet1', 2, '{}', '{"备注":"探针说明"}',
        '', 'pending', 'pending', '', ?, ?)
    `).run(timestamp, timestamp);
    const insertField = db.prepare(`
      INSERT INTO analysis_fields (
        id, section_id, key, label, field_type, prompt, options_json,
        is_required, image_enabled, depends_on_json, sort_order, execution_type,
        export_enabled, candidate_limit, is_enabled, created_at, updated_at
      ) VALUES (?, 'probe-board', ?, ?, ?, ?, '[]', 0, 0, ?, ?, ?, 1, 15, 1, ?, ?)
    `);
    insertField.run(
      "probe-attribution", "探针归因", "探针归因", "object", "探针归因提示",
      '["备注"]', 0, "probe_structured_analysis", timestamp, timestamp,
    );
    insertField.run(
      "probe-conclusion", "探针结论", "探针结论", "string", "",
      '["探针归因"]', 1, "probe_structured_derive", timestamp, timestamp,
    );
    insertField.run(
      "probe-evidence", "探针依据", "探针依据", "string", "",
      '["探针归因"]', 2, "probe_structured_derive", timestamp, timestamp,
    );
  });

  it("runs a new structured board without touching the scheduler or registry", async () => {
    vi.mocked(callModelPool).mockImplementation(async () => routedResponse(JSON.stringify({
      conclusion: "探针完成",
      evidence: ["探针说明"],
    })));

    const progress = await analyzeRecordFields("probe-record", "probe-board");

    expect(progress).toEqual({ total: 3, completed: 3, failed: 0, needsReview: 0, skipped: 0 });
    const runs = db.prepare(`
      SELECT f.key, r.status, r.result_json, r.evidence_text, r.model_config_snapshot_json
      FROM analysis_field_runs r
      JOIN analysis_fields f ON f.id = r.field_id
      WHERE r.record_id = 'probe-record'
    `).all() as Array<{
      key: string;
      status: string;
      result_json: string;
      evidence_text: string | null;
      model_config_snapshot_json: string;
    }>;
    const results = Object.fromEntries(runs.map((run) => [run.key, JSON.parse(run.result_json)]));
    expect(results["探针归因"]).toEqual({ 探针归因: { conclusion: "探针完成", evidence: ["探针说明"] } });
    expect(results["探针结论"]).toEqual({ 探针结论: "探针完成" });
    expect(results["探针依据"]).toEqual({ 探针依据: "探针说明" });
    expect(runs.find((run) => run.key === "探针结论")?.evidence_text).toBe("探针说明");
    expect(JSON.parse(runs.find((run) => run.key === "探针结论")!.model_config_snapshot_json))
      .toEqual({ strategy: "local_rules" });
    expect(vi.mocked(callModelPool)).toHaveBeenCalledTimes(1);
  });
});
