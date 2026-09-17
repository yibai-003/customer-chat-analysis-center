import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../../config";
import { db, initDb } from "../../db/client";
import { getRecord, upsertSection } from "../../db/repositories";
import { createModelConfig, setDefaultModel } from "../model-config-service";
import { upsertField } from "../field-config-service";
import { importWorkbook } from "../excel-import-service";
import { exportJob } from "../excel-export-service";
import { analyzeField } from "../field-analysis-service";
import { importKnowledgeWorkbook } from "./knowledge-import-service";
import { createKnowledgeWorkbook } from "./knowledge-test-fixtures";
import {
  deleteKnowledgeItem,
  getKnowledgeItem,
  listKnowledgeItems,
  upsertKnowledgeBase,
  upsertKnowledgeItem,
} from "./knowledge-repository";

const screenshotPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("dynamic reason knowledge flow", () => {
  const sectionId = "task-9-reason-flow";
  const recordIdQuery = "SELECT id FROM records WHERE job_id = ?";
  const generatedFiles = new Set<string>();
  const generatedDirectories = new Set<string>();

  beforeAll(() => initDb());

  beforeEach(() => {
    db.exec(`
      DELETE FROM knowledge_match_snapshots;
      DELETE FROM analysis_field_runs;
      DELETE FROM records;
      DELETE FROM jobs;
      DELETE FROM analysis_fields WHERE section_id = '${sectionId}';
      DELETE FROM knowledge_items;
      DELETE FROM knowledge_bases;
      DELETE FROM analysis_sections WHERE id = '${sectionId}';
      DELETE FROM model_configs;
    `);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      Array.from(generatedFiles, (filePath) => fs.rm(filePath, { force: true })),
    );
    await Promise.all(
      Array.from(generatedDirectories, (directoryPath) => (
        fs.rm(directoryPath, { recursive: true, force: true })
      )),
    );
    generatedFiles.clear();
    generatedDirectories.clear();
  });

  it("fails over one text route, writes one match snapshot, and exports only public results", async () => {
    upsertSection({
      id: sectionId,
      parentId: null,
      name: "退货分析",
      prompt: "分析退货原因",
      sourceFields: ["客户描述"],
      outputSchema: [],
      sortOrder: 99,
      imageEnabled: true,
    });

    const knowledgeFile = await createKnowledgeWorkbook({
      headers: ["一级原因", "二级原因", "三级原因", "检索关键词"],
      rows: [[
        "工厂问题",
        "品质-面板故障",
        "弹簧片掉落",
        "面板弹簧片掉落",
      ]],
      sheetName: "动态原因",
    });
    generatedFiles.add(knowledgeFile);
    const knowledgeBase = upsertKnowledgeBase({
      id: "task-9-reason-base",
      sectionId,
      name: "动态原因库",
      originalFilename: "动态原因.xlsx",
      columns: [
        { name: "一级原因", roles: ["result", "search"] },
        { name: "二级原因", roles: ["result", "search"] },
        { name: "三级原因", roles: ["result", "search"] },
        { name: "检索关键词", roles: ["keyword"] },
      ],
      isEnabled: true,
    });
    await importKnowledgeWorkbook({
      filePath: knowledgeFile,
      originalFilename: "动态原因.xlsx",
      sectionId,
      knowledgeBaseId: knowledgeBase.id,
    });
    const item = listKnowledgeItems(knowledgeBase.id).items[0];

    upsertField({
      id: "task-9-screenshot",
      sectionId,
      key: "screenshotContent",
      label: "截图解析",
      type: "string",
      prompt: "读取截图中的客观事实",
      required: true,
      imageEnabled: true,
      dependsOn: [],
      sortOrder: 0,
      isEnabled: true,
      executionType: "ai",
      exportEnabled: false,
    });
    upsertField({
      id: "task-9-match",
      sectionId,
      key: "reasonPathMatch",
      label: "原因路径匹配",
      type: "string",
      prompt: "只能选择候选中的完整原因路径",
      required: true,
      imageEnabled: false,
      dependsOn: ["screenshotContent"],
      sortOrder: 1,
      isEnabled: true,
      executionType: "knowledge_match",
      exportEnabled: false,
      knowledgeBaseId: knowledgeBase.id,
    });
    for (const [sortOrder, field] of [
      [2, ["level1", "一级选项", "一级原因"]],
      [3, ["level2", "二级选项", "二级原因"]],
      [4, ["level3", "三级选项", "三级原因"]],
    ] as const) {
      upsertField({
        id: `task-9-${field[0]}`,
        sectionId,
        key: field[0],
        label: field[1],
        type: "string",
        prompt: "",
        required: false,
        imageEnabled: false,
        dependsOn: ["reasonPathMatch"],
        sortOrder,
        isEnabled: true,
        executionType: "knowledge_extract",
        exportEnabled: true,
        outputColumn: field[1],
        matchFieldKey: "reasonPathMatch",
        knowledgeColumn: field[2],
      });
    }

    const sourcePath = path.join(os.tmpdir(), `task-9-source-${process.pid}.xlsx`);
    generatedFiles.add(sourcePath);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("客服记录");
    worksheet.addRow(["客户描述"]);
    worksheet.addRow(["面板弹簧片掉落"]);
    worksheet.addImage(workbook.addImage({
      base64: `data:image/png;base64,${screenshotPngBase64}`,
      extension: "png",
    }), "B2:D9");
    await workbook.xlsx.writeFile(sourcePath);

    const visionModel = createModelConfig({
      name: "task-9-vision",
      baseUrl: "https://vision.example/v1",
      apiKey: "vision-key",
      model: "vision-model",
      supportsVision: true,
      purpose: "vision",
      temperature: 0,
      maxTokens: 500,
    });
    const firstTextModel = createModelConfig({
      name: "task-9-text-first",
      baseUrl: "https://text-first.example/v1",
      apiKey: "text-first-key",
      model: "text-first-model",
      supportsVision: false,
      purpose: "text",
      temperature: 0,
      maxTokens: 500,
    });
    const secondTextModel = createModelConfig({
      name: "task-9-text-second",
      baseUrl: "https://text-second.example/v1",
      apiKey: "text-second-key",
      model: "text-second-model",
      supportsVision: false,
      purpose: "text",
      temperature: 0,
      maxTokens: 500,
    });
    setDefaultModel(visionModel.id, "vision");
    setDefaultModel(firstTextModel.id, "text");
    const capabilityCheckedAt = Date.now();
    const quotaExpiresAt = "2026-10-01T00:00:00.000Z";
    const enablePoolMember = db.prepare(`
      UPDATE model_configs
      SET pool_enabled=1, billing_mode='free', priority=?,
          quota_total_tokens=10000, quota_used_tokens=0, quota_expires_at=?,
          capability_json=?, capability_checked_at=?
      WHERE id=?
    `);
    enablePoolMember.run(
      1,
      quotaExpiresAt,
      JSON.stringify({ text: true, json: true, vision: true, errors: {} }),
      capabilityCheckedAt,
      visionModel.id,
    );
    enablePoolMember.run(
      1,
      quotaExpiresAt,
      JSON.stringify({ text: true, json: true, vision: false, errors: {} }),
      capabilityCheckedAt,
      firstTextModel.id,
    );
    enablePoolMember.run(
      2,
      quotaExpiresAt,
      JSON.stringify({ text: true, json: true, vision: false, errors: {} }),
      capabilityCheckedAt,
      secondTextModel.id,
    );

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      const serialized = JSON.stringify(request.messages);
      if (request.model === "text-first-model") {
        return new Response(JSON.stringify({
          error: { message: "rate limited" },
        }), { status: 429, headers: { "Content-Type": "application/json" } });
      }
      const content = serialized.includes("image_url")
        ? JSON.stringify({ screenshotContent: "面板弹簧片掉落" })
        : JSON.stringify({ knowledgeItemId: item.id });
      return new Response(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const job = await importWorkbook(sourcePath, "客服记录.xlsx", {
      id: sectionId,
      name: "退货分析",
    });
    generatedDirectories.add(path.join(config.dataDir, "jobs", job.id));
    const recordId = (db.prepare(recordIdQuery).get(job.id) as { id: string }).id;

    await analyzeField(recordId, sectionId, "screenshotContent");

    const snapshot = db.prepare(`
      SELECT id, knowledge_item_id, item_values_json
      FROM knowledge_match_snapshots
      WHERE record_id = ?
    `).get(recordId) as {
      id: string;
      knowledge_item_id: string;
      item_values_json: string;
    };
    expect(snapshot.knowledge_item_id).toBe(item.id);
    expect(JSON.parse(snapshot.item_values_json)).toEqual({
      一级原因: "工厂问题",
      二级原因: "品质-面板故障",
      三级原因: "弹簧片掉落",
      检索关键词: "面板弹簧片掉落",
    });

    upsertKnowledgeItem({
      ...item,
      values: {
        一级原因: "已修改一级",
        二级原因: "已修改二级",
        三级原因: "已修改三级",
        检索关键词: "已修改关键词",
      },
    });
    deleteKnowledgeItem(item.id);
    expect(getKnowledgeItem(item.id)).toBeUndefined();

    await analyzeField(recordId, sectionId, "level1");
    await analyzeField(recordId, sectionId, "level2");
    await analyzeField(recordId, sectionId, "level3");

    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const modelCalls = fetchMock.mock.calls.map(([input, init]) => ({
      url: String(input),
      body: JSON.parse(String(init?.body)) as {
        model: string;
        messages: unknown[];
      },
    }));
    expect(modelCalls).toEqual([
      {
        url: "https://vision.example/v1/chat/completions",
        body: expect.objectContaining({
          model: "vision-model",
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.arrayContaining([
                expect.objectContaining({ type: "image_url" }),
              ]),
            }),
          ]),
        }),
      },
      {
        url: "https://text-first.example/v1/chat/completions",
        body: expect.objectContaining({
          model: "text-first-model",
          messages: expect.not.arrayContaining([
            expect.objectContaining({
              content: expect.arrayContaining([
                expect.objectContaining({ type: "image_url" }),
              ]),
            }),
          ]),
        }),
      },
      {
        url: "https://text-second.example/v1/chat/completions",
        body: expect.objectContaining({
          model: "text-second-model",
          messages: expect.not.arrayContaining([
            expect.objectContaining({
              content: expect.arrayContaining([
                expect.objectContaining({ type: "image_url" }),
              ]),
            }),
          ]),
        }),
      },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_match_snapshots WHERE record_id = ?").get(recordId))
      .toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT event_type, model_config_id, error_code
      FROM model_usage_events
      WHERE record_id = ? AND field_id = 'task-9-match' AND operation = 'knowledge_match'
      ORDER BY rowid
    `).all(recordId)).toEqual([
      {
        event_type: "failure",
        model_config_id: firstTextModel.id,
        error_code: "rate_limit",
      },
      {
        event_type: "cooldown",
        model_config_id: firstTextModel.id,
        error_code: null,
      },
      {
        event_type: "switch",
        model_config_id: firstTextModel.id,
        error_code: "rate_limit",
      },
      {
        event_type: "success",
        model_config_id: secondTextModel.id,
        error_code: null,
      },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM analysis_field_runs WHERE field_id IN ('task-9-level1', 'task-9-level2', 'task-9-level3') AND model_config_snapshot_json = '{}'").get())
      .toEqual({ count: 6 });

    const detail = getRecord(recordId)!;
    const fieldRunResults = Object.fromEntries(
      detail.fieldRuns.map((run) => [run.fieldKey, run.result]),
    );
    expect(fieldRunResults).toMatchObject({
      level1: { level1: "工厂问题" },
      level2: { level2: "品质-面板故障" },
      level3: { level3: "弹簧片掉落" },
    });

    const expectedOutputPath = path.join(
      config.dataDir,
      "exports",
      `${job.id}-客服解析结果.xlsx`,
    );
    generatedFiles.add(expectedOutputPath);
    const outputPath = await exportJob(job.id, [sectionId]);
    expect(outputPath).toBe(expectedOutputPath);
    const exported = new ExcelJS.Workbook();
    await exported.xlsx.readFile(outputPath);
    const headers = exported.worksheets[0].getRow(1).values as unknown[];
    expect(headers).toContain("一级选项");
    expect(headers).toContain("二级选项");
    expect(headers).toContain("三级选项");
    expect(headers).not.toContain("原因路径匹配");
    expect(headers).not.toContain("截图解析");
    expect(exported.worksheets[0].getRow(2).values).toEqual([
      ,
      "面板弹簧片掉落",
      "工厂问题",
      "品质-面板故障",
      "弹簧片掉落",
    ]);
  });
});
