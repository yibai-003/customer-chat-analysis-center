import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import unzipper from "unzipper";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ModelConfig,
  ModelPurpose,
  ModelRouteResult,
} from "../../shared/types";
import { initDb } from "../db/client";
import {
  createPlatform,
  getJob,
  getRecord,
  getSection,
  listJobs,
  listRecords,
} from "../db/repositories";
import { analyzeJob } from "./batch-analysis-service";
import { exportJob } from "./excel-export-service";
import { aggregateFieldResultsForFields } from "./field-run-service";
import { analyzeField } from "./field-analysis-service";
import {
  activateSectionVersion,
  createDraftVersion,
  getJobSectionConfigVersion,
  getSectionVersion,
  publishSectionVersion,
  updateDraftSectionVersion,
} from "./section-config-version-service";
import {
  importWorkbookStreaming,
  previewWorkbookStreaming,
} from "./streaming-xlsx-import-service";

vi.mock("./model-pool-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-pool-service")>();
  return { ...actual, callModelPool: vi.fn() };
});

import {
  callModelPool,
  type ModelPoolCallOptions,
} from "./model-pool-service";

const screenshotPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAC0lEQVR42u3PQQ0AAAgDINc/9K3hHFQgE1nS3QEAAAAAAAAAAAAAAAAAAAAAAAB8GQJAAAHQxV8AAAAASUVORK5CYII=",
  "base64",
);
const resultHeaders = [
  "问题点-售前",
  "问题点-售后",
  "有无违规-售后",
  "客服问题 识别问题并打标签",
  "接待流程质检结果",
  "优化建议-售前",
];
const sourceHeaders = [
  "店铺",
  "日期",
  "客服",
  "客户ID",
  "分组",
  "平台店铺商品编码",
  "商品名称",
  "聊天截图",
  "订单号",
  "颜色款式",
  "品类",
  ...resultHeaders,
  "问题",
  "保留公式",
  "原始备注",
];

function model(purpose: ModelPurpose): ModelConfig {
  return {
    id: `release-gate-${purpose}`,
    name: `release gate ${purpose}`,
    baseUrl: "https://release-gate.invalid/v1",
    maskedApiKey: "********",
    model: `controlled-${purpose}`,
    supportsVision: purpose === "vision",
    temperature: 0,
    maxTokens: 1000,
    isDefault: false,
    purpose,
    isPurposeDefault: true,
    isEnabled: true,
    poolEnabled: true,
    billingMode: "free",
    qualityTier: "A",
    priority: 100,
    thinkingMode: false,
    memberType: "general",
    quotaTotalTokens: 1_000_000,
    quotaUsedTokens: 0,
    quotaSafetyRatio: 0.95,
    consecutiveFailures: 0,
    capabilityEligible: true,
    quotaBlocked: false,
  };
}

function response(purpose: ModelPurpose, content: unknown): ModelRouteResult {
  const selected = model(purpose);
  return {
    content: JSON.stringify(content),
    raw: JSON.stringify({ controlled: true, purpose }),
    usage: { prompt_tokens: 20, completion_tokens: 10 },
    model: selected,
    attempts: [{
      modelConfigId: selected.id,
      model: selected.model,
      status: "success",
      durationMs: 1,
    }],
  };
}

function addScreenshot(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
) {
  const image = workbook.addImage({ buffer: screenshotPng as any, extension: "png" });
  sheet.addImage(image, {
    tl: { col: 7, row: rowNumber - 1 },
    ext: { width: 420, height: 180 },
    editAs: "oneCell",
  });
  sheet.getRow(rowNumber).height = 140;
}

async function writeReleaseGateWorkbook(target: string) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "客服解析中心工单7脱敏验收";
  workbook.created = new Date("2026-09-23T00:00:00.000Z");
  const sheet = workbook.addWorksheet("接待质检明细", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.addRow(sourceHeaders);
  sheet.addRow([
    "旗舰店A", "2026-09-22", "客服甲", "U-1001", "售前一组", "SKU-BLUE", "旅行箱",
    "", "RG-NO-ISSUE", "蓝色", "箱包", "", "", "", "", "", "", "", "",
    { formula: "LEN(I2)", result: 11 }, "合规会话",
  ]);
  sheet.addRow([
    "旗舰店A", "2026-09-22", "客服乙", "U-1002", "售前一组", "SKU-SIZE", "针织衫",
    "", "RG-SINGLE", "米白", "服饰", "", "", "", "", "", "", "", "",
    { formula: "LEN(I3)", result: 9 }, "单问题会话",
  ]);
  sheet.addRow([
    "旗舰店A", "2026-09-22", "客服丙", "U-1003", "售前二组", "SKU-D", "运动鞋",
    "", "RG-MULTI-D", "黑色", "鞋靴", "", "", "", "", "", "", "", "",
    { formula: "LEN(I4)", result: 10 }, "多问题及D级",
  ]);
  sheet.addRow([
    "旗舰店A", "2026-09-22", "客服丁", "U-1004", "售前二组", "SKU-TIME", "保温杯",
    "", "RG-REVIEW", "白色", "百货", "", "", "", "", "", "", "", "",
    { formula: "LEN(I5)", result: 9 }, "缺少可靠完整时间",
  ]);
  sheet.addRow([
    "旗舰店A", "2026-09-21", "客服戊", "U-0999", "历史组", "SKU-HISTORY", "历史商品",
    "", "RG-HISTORY", "灰色", "历史", "无", "无", "无违规", "无", "B", "保持规范",
    "历史问题", { formula: "LEN(I6)", result: 10 }, "完整历史结果不得覆盖",
  ]);
  sheet.addRow([
    "预留店铺", "2026-09-23", "待分配", "U-EMPTY", "预留组", "", "",
    "", "RG-PLACEHOLDER", "", "", "", "", "", "", "", "", "预留问题",
    { formula: "LEN(I7)", result: 14 }, "无图片预留行保持不变",
  ]);
  sheet.getCell("A7").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFE699" },
  };
  sheet.getCell("T7").font = { bold: true, color: { argb: "FF9C0006" } };
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF4472C4" },
  };
  for (const rowNumber of [2, 3, 4, 5, 6]) addScreenshot(workbook, sheet, rowNumber);
  await workbook.xlsx.writeFile(target);
}

async function writeConflictWorkbook(target: string) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("部分结果冲突");
  sheet.addRow(sourceHeaders);
  sheet.addRow([
    "旗舰店A", "2026-09-23", "客服冲突", "U-CONFLICT", "冲突组", "SKU-CONFLICT", "冲突商品",
    "", "RG-CONFLICT", "", "", "答非所问", "", "", "", "", "", "", "",
    { formula: "LEN(I2)", result: 11 }, "部分结果必须阻断整单",
  ]);
  addScreenshot(workbook, sheet, 2);
  await workbook.xlsx.writeFile(target);
}

function sectionInput(versionId: string) {
  const section = getSection("reception")!;
  const version = getSectionVersion(versionId)!;
  return {
    id: section.id,
    name: section.name,
    sourceFields: section.sourceFields,
    sectionConfigVersionId: version.id,
    sectionVersionNumber: version.versionNumber,
  };
}

function orderNumber(recordId?: string) {
  if (!recordId) throw new Error("受控模型调用缺少记录 ID");
  const record = getRecord(recordId);
  if (!record) throw new Error("受控模型调用记录不存在");
  return String(record.sourceFields["订单号"] ?? "");
}

function factsFor(order: string) {
  const common = {
    sceneHints: ["售前"],
    customerIntents: ["咨询商品"],
    serviceActions: ["人工客服回复"],
    businessFacts: [],
    missingSignals: [],
  };
  if (order === "RG-NO-ISSUE") {
    return {
      ...common,
      dialogueTurns: [
        { id: "T1", speaker: "客户", time: "2026-09-22 09:00:00", text: "这款有蓝色吗" },
        { id: "T2", speaker: "客服", time: "2026-09-22 09:00:15", text: "有的，可以选择蓝色" },
      ],
    };
  }
  if (order === "RG-SINGLE") {
    return {
      ...common,
      dialogueTurns: [
        { id: "T1", speaker: "客户", time: "2026-09-22 09:10:00", text: "请问这款尺码怎么选" },
        { id: "T2", speaker: "客服", time: "2026-09-22 09:10:10", text: "今天天气不错" },
      ],
    };
  }
  if (order === "RG-MULTI-D") {
    return {
      ...common,
      dialogueTurns: [
        { id: "T1", speaker: "客户", time: "2026-09-22 09:20:00", text: "请问这款尺码怎么选" },
        { id: "T2", speaker: "客服", time: "2026-09-22 09:20:12", text: "这个我不处理，您自己看天气吧" },
      ],
    };
  }
  return {
    ...common,
    dialogueTurns: [
      { id: "T1", speaker: "客户", time: "09:30", text: "这个杯子能保温多久" },
      { id: "T2", speaker: "客服", time: "09:31", text: "详情页标注为六小时" },
    ],
    missingSignals: ["截图只显示时分，缺少完整日期"],
  };
}

function issue(issueId: string, chatQuotes: string[], evidenceExplanation: string, reason: string) {
  return {
    issueId,
    evidenceIds: ["T2"],
    chatQuotes,
    evidenceExplanation,
    reason,
  };
}

function qualityFor(order: string, recordId?: string) {
  const record = getRecord(recordId!);
  const version = record ? getJobSectionConfigVersion(record.jobId) : undefined;
  const versionRules = version?.businessRules as {
    issues?: Array<{ id: string; scope: string }>;
  } | undefined;
  const rules = versionRules?.issues ?? [];
  const checkedRuleIds = rules
    .filter((rule) => rule.scope === "preSale")
    .map((rule) => rule.id);
  const base = {
    scene: "售前",
    checkedRuleIds,
    afterSaleIssues: [],
    blockingUnverifiableItems: [],
    informationalUnverifiableItems: [],
    confidence: 0.96,
  };
  if (order === "RG-SINGLE") {
    return {
      ...base,
      preSaleIssues: [issue(
        "PRE_ANSWER_IRRELEVANT",
        ["今天天气不错"],
        "客服回复未回应尺码问题",
        "客户询问尺码，客服回复与问题无关",
      )],
    };
  }
  if (order === "RG-MULTI-D") {
    return {
      ...base,
      preSaleIssues: [
        issue(
          "PRE_ANSWER_IRRELEVANT",
          ["这个我不处理，您自己看天气吧"],
          "客服没有回应尺码选择",
          "回复内容与客户核心问题无关",
        ),
        issue(
          "PRE_PASSIVE_SERVICE",
          ["这个我不处理，您自己看天气吧"],
          "客服明确拒绝继续接待",
          "出现明确拒绝处理和推诿表达",
        ),
      ],
    };
  }
  return { ...base, preSaleIssues: [] };
}

function column(sheet: ExcelJS.Worksheet, header: string) {
  return (sheet.getRow(1).values as unknown[])
    .findIndex((value) => String(value ?? "") === header);
}

function qualityResult(recordId: string) {
  const record = getRecord(recordId)!;
  const version = getJobSectionConfigVersion(record.jobId)!;
  return aggregateFieldResultsForFields(record.id, version.fieldsSnapshot)["统一质检分析"] as {
    labels: string[];
    dimensions: string[];
    deductions: number[];
    totalDeduction: number;
    grade: string;
    reviewRequired: boolean;
    conversationStartTime: string;
  };
}

function hash(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function fileSha256(file: string) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function assertOoxmlPackage(file: string) {
  const directory = await unzipper.Open.file(file);
  const entries = new Set(directory.files.map((entry) => entry.path));
  for (const required of [
    "[Content_Types].xml",
    "xl/workbook.xml",
    "xl/styles.xml",
    "xl/worksheets/sheet1.xml",
    "xl/drawings/drawing1.xml",
  ]) {
    expect(entries.has(required), `OOXML 缺少 ${required}`).toBe(true);
  }
  expect([...entries].some((entry) => entry.startsWith("xl/media/"))).toBe(true);
}

describe("realistic anonymized reception XLSX release gate", { timeout: 40_000 }, () => {
  let workspace = "";
  let originalCurrentVersionId = "";
  let samplePath = "";
  let conflictPath = "";
  let exportedArtifactPath = "";
  let sampleProvenance: "generated-synthetic" | "external-real" = "generated-synthetic";
  let sourceSamplePath = "";
  const gateArtifactDir = process.env.RECEPTION_GATE_ARTIFACT_DIR
    ? path.resolve(process.env.RECEPTION_GATE_ARTIFACT_DIR)
    : "";
  const externalRealSample = process.env.RECEPTION_XLSX_REAL_SAMPLE
    ? path.resolve(process.env.RECEPTION_XLSX_REAL_SAMPLE)
    : "";

  beforeAll(async () => {
    initDb();
    originalCurrentVersionId = getSection("reception")!.currentVersionId!;
    workspace = gateArtifactDir || await fs.mkdtemp(path.join(os.tmpdir(), "reception-xlsx-release-gate-"));
    await fs.mkdir(workspace, { recursive: true });
    samplePath = path.join(workspace, "reception-quality-anonymized.xlsx");
    conflictPath = path.join(workspace, "reception-quality-partial-conflict.xlsx");
    if (externalRealSample) {
      await fs.access(externalRealSample);
      sourceSamplePath = externalRealSample;
      sampleProvenance = "external-real";
      if (path.resolve(externalRealSample) !== path.resolve(samplePath)) {
        await fs.copyFile(externalRealSample, samplePath);
      }
    } else {
      await writeReleaseGateWorkbook(samplePath);
    }
    await writeConflictWorkbook(conflictPath);
  });

  afterAll(async () => {
    if (originalCurrentVersionId) activateSectionVersion(originalCurrentVersionId);
    if (!gateArtifactDir && workspace) {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("passes import, analysis, rollback isolation, retry, export and reread gates", async () => {
    const historicalVersion = getSectionVersion(originalCurrentVersionId)!;
    const draft = createDraftVersion("reception");
    const nextRules = structuredClone(draft.businessRules) as {
      issues: Array<{ id: string; deduction: number }>;
    };
    nextRules.issues.find((item) => item.id === "PRE_ANSWER_IRRELEVANT")!.deduction = 17;
    updateDraftSectionVersion(draft.id, {
      businessRules: nextRules as unknown as Record<string, unknown>,
    });
    const newVersion = publishSectionVersion(draft.id);
    const newVersionKnowledgeHash = hash(newVersion.knowledgeSnapshot);
    const newVersionRulesHash = hash(newVersion.businessRules);
    const platform = createPlatform({
      name: "抖音脱敏验收平台",
      code: `DYRG${Date.now()}`,
    });

    const preview = await previewWorkbookStreaming(
      samplePath,
      path.basename(samplePath),
      sectionInput(newVersion.id),
      platform,
    );
    expect(preview).toMatchObject({
      sheetCount: 1,
      imageCount: 5,
      pendingRecordCount: 4,
      historicalResultCount: 1,
      resultConflicts: [],
      platformConflicts: [],
      sectionConfigVersionId: newVersion.id,
      platformId: platform.id,
    });
    expect(preview.sheets[0].headers).not.toContain("平台");
    expect(preview.sheets[0].imageRows).toEqual([2, 3, 4, 5, 6]);

    const taskOne = await importWorkbookStreaming(
      samplePath,
      path.basename(samplePath),
      sectionInput(newVersion.id),
      undefined,
      platform,
    );
    expect(taskOne.sectionConfigVersionId).toBe(newVersion.id);
    expect(listRecords(taskOne.id).map((record) => record.rowNumber)).toEqual([2, 3, 4, 5]);

    vi.mocked(callModelPool).mockImplementation(
      async (_messages: unknown[], options: ModelPoolCallOptions) => {
        const order = orderNumber(options.recordId);
        return options.purpose === "vision"
          ? response("vision", { 截图内容总结: factsFor(order) })
          : response("text", qualityFor(order, options.recordId));
      },
    );
    const firstProgress = await analyzeJob(taskOne.id, "reception", {
      concurrency: 1,
      batchSize: 5,
    });
    expect(firstProgress).toMatchObject({
      total: 4,
      completed: 3,
      failed: 0,
      needsReview: 1,
    });

    const firstRecords = listRecords(taskOne.id);
    const byOrder = new Map(firstRecords.map((record) => [
      record.sourceFields["订单号"],
      record,
    ]));
    expect(qualityResult(byOrder.get("RG-NO-ISSUE")!.id)).toMatchObject({
      labels: [],
      deductions: [],
      totalDeduction: 0,
      grade: "A",
      reviewRequired: false,
    });
    expect(qualityResult(byOrder.get("RG-SINGLE")!.id)).toMatchObject({
      labels: ["答非所问"],
      dimensions: ["问题解决"],
      deductions: [17],
      totalDeduction: 17,
      reviewRequired: false,
    });
    expect(qualityResult(byOrder.get("RG-MULTI-D")!.id)).toMatchObject({
      labels: ["服务消极D级", "答非所问"],
      dimensions: ["服务态度", "问题解决"],
      deductions: [0, 17],
      totalDeduction: 17,
      grade: "D",
      reviewRequired: false,
    });
    expect(qualityResult(byOrder.get("RG-REVIEW")!.id)).toMatchObject({
      labels: [],
      deductions: [],
      reviewRequired: true,
      conversationStartTime: "",
    });
    expect(byOrder.get("RG-REVIEW")!.status).toBe("needs_review");
    for (const record of firstRecords) {
      expect(record.conversationId).toMatch(new RegExp(`^${platform.code}\\d{8}[A-Z0-9]{6}$`));
    }
    const idsBeforeRetry = Object.fromEntries(firstRecords.map((record) => [
      record.sourceFields["订单号"],
      record.conversationId,
    ]));

    const jobsBeforeConflict = listJobs().length;
    const conflictPreview = await previewWorkbookStreaming(
      conflictPath,
      path.basename(conflictPath),
      sectionInput(newVersion.id),
      platform,
    );
    expect(conflictPreview.resultConflicts).toEqual([
      expect.objectContaining({
        sheetName: "部分结果冲突",
        rowNumber: 2,
      }),
    ]);
    await expect(importWorkbookStreaming(
      conflictPath,
      path.basename(conflictPath),
      sectionInput(newVersion.id),
      undefined,
      platform,
    )).rejects.toThrow(/部分结果冲突 第 2 行.*缺失字段/s);
    expect(listJobs()).toHaveLength(jobsBeforeConflict);

    activateSectionVersion(historicalVersion.id);
    const taskTwo = await importWorkbookStreaming(
      samplePath,
      "reception-quality-after-rollback.xlsx",
      sectionInput(historicalVersion.id),
      undefined,
      platform,
    );
    expect(taskTwo.sectionConfigVersionId).toBe(historicalVersion.id);
    expect(getJob(taskOne.id)?.sectionConfigVersionId).toBe(newVersion.id);
    const taskTwoSingle = listRecords(taskTwo.id)
      .find((record) => record.sourceFields["订单号"] === "RG-SINGLE")!;
    await analyzeJob(taskTwo.id, "reception", {
      concurrency: 1,
      batchSize: 5,
      recordIds: [taskTwoSingle.id],
    });
    expect(qualityResult(taskTwoSingle.id)).toMatchObject({
      labels: ["答非所问"],
      dimensions: ["问题解决"],
      deductions: [10],
      totalDeduction: 10,
    });

    const retryRecord = byOrder.get("RG-MULTI-D")!;
    await analyzeField(retryRecord.id, "reception", "统一质检分析");
    const taskOneVersionAfterRetry = getJobSectionConfigVersion(taskOne.id)!;
    expect(taskOneVersionAfterRetry.id).toBe(newVersion.id);
    expect(hash(taskOneVersionAfterRetry.knowledgeSnapshot)).toBe(newVersionKnowledgeHash);
    expect(hash(taskOneVersionAfterRetry.businessRules)).toBe(newVersionRulesHash);
    expect(qualityResult(retryRecord.id)).toMatchObject({
      labels: ["服务消极D级", "答非所问"],
      dimensions: ["服务态度", "问题解决"],
      deductions: [0, 17],
      totalDeduction: 17,
      grade: "D",
    });
    expect(getRecord(retryRecord.id)?.conversationId).toBe(idsBeforeRetry["RG-MULTI-D"]);
    for (const record of listRecords(taskOne.id)) {
      expect(record.conversationId).toBe(idsBeforeRetry[record.sourceFields["订单号"]]);
    }

    const exported = await exportJob(taskOne.id);
    exportedArtifactPath = gateArtifactDir
      ? path.join(workspace, "reception-quality-anonymized-export.xlsx")
      : exported;
    if (gateArtifactDir) await fs.copyFile(exported, exportedArtifactPath);
    const reread = new ExcelJS.Workbook();
    await reread.xlsx.readFile(exportedArtifactPath);
    const sheet = reread.getWorksheet("接待质检明细")!;
    expect(reread.worksheets.map((item) => item.name)).toEqual(["接待质检明细"]);
    expect(sheet.rowCount).toBe(7);
    expect(sheet.getImages()).toHaveLength(5);
    expect(sheet.getImages().map((image) =>
      Number((image.range as any).tl.nativeRow ?? (image.range as any).tl.row) + 1))
      .toEqual([2, 3, 4, 5, 6]);
    expect(sheet.getCell("A7").fill).toMatchObject({
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFFE699" },
    });
    expect(sheet.getCell("S7").value).toMatchObject({ formula: "LEN(I7)" });
    expect(sheet.getCell("T7").value).toBe("无图片预留行保持不变");
    expect(sheet.getCell("T7").font).toMatchObject({
      bold: true,
      color: { argb: "FF9C0006" },
    });
    expect(sheet.getRow(7).getCell(column(sheet, "问题")).value).toBe("预留问题");
    expect(sheet.getRow(7).getCell(column(sheet, "平台")).value).toBeNull();
    expect(sheet.getRow(7).getCell(column(sheet, "会话ID")).value).toBeNull();
    expect(sheet.getRow(6).getCell(column(sheet, "接待流程质检结果")).value).toBe("B");
    expect(sheet.getRow(6).getCell(column(sheet, "问题")).value).toBe("历史问题");

    expect(sheet.getRow(2).getCell(column(sheet, "平台")).value).toBe(platform.name);
    expect(sheet.getRow(2).getCell(column(sheet, "问题")).value).toBe("");
    expect(sheet.getRow(2).getCell(column(sheet, "合计扣分")).value).toBe(0);
    expect(sheet.getRow(2).getCell(column(sheet, "接待流程质检结果")).value).toBe("A");
    expect(sheet.getRow(2).getCell(column(sheet, "是否待人工复核")).value).toBe("否");

    expect(sheet.getRow(3).getCell(column(sheet, "问题")).value).toBe("答非所问");
    expect(sheet.getRow(3).getCell(column(sheet, "维度")).value).toBe("问题解决");
    expect(sheet.getRow(3).getCell(column(sheet, "扣分")).value).toBe("17");
    expect(sheet.getRow(4).getCell(column(sheet, "问题")).value).toBe("服务消极D级/答非所问");
    expect(sheet.getRow(4).getCell(column(sheet, "维度")).value).toBe("服务态度/问题解决");
    expect(sheet.getRow(4).getCell(column(sheet, "扣分")).value).toBe("0/17");
    expect(sheet.getRow(4).getCell(column(sheet, "是否D级")).value).toBe("是");
    expect(sheet.getRow(4).getCell(column(sheet, "接待流程质检结果")).value).toBe("D");
    expect(sheet.getRow(4).getCell(column(sheet, "证据说明")).value)
      .toBe("客服明确拒绝继续接待/客服没有回应尺码选择");
    expect(sheet.getRow(5).getCell(column(sheet, "是否待人工复核")).value).toBe("是");
    expect(sheet.getRow(5).getCell(column(sheet, "会话开始时间")).value).toBe("");
    expect(sheet.getRow(5).getCell(column(sheet, "会话ID")).value).toBe(idsBeforeRetry["RG-REVIEW"]);
    await assertOoxmlPackage(exportedArtifactPath);

    const report = {
      ticket: 7,
      generatedAt: new Date().toISOString(),
      samplePath,
      sample: {
        provenance: sampleProvenance,
        sourcePath: sourceSamplePath || samplePath,
        artifactPath: samplePath,
        sha256: await fileSha256(samplePath),
      },
      conflictSamplePath: conflictPath,
      platform: {
        id: platform.id,
        code: platform.code,
        name: platform.name,
      },
      versions: {
        new: { id: newVersion.id, number: newVersion.versionNumber },
        historical: { id: historicalVersion.id, number: historicalVersion.versionNumber },
        taskOneKnowledgeSnapshotSha256: newVersionKnowledgeHash,
        taskOneBusinessRulesSha256: newVersionRulesHash,
      },
      tasks: {
        taskOne: { id: taskOne.id, versionId: newVersion.id },
        taskTwo: { id: taskTwo.id, versionId: historicalVersion.id },
      },
      sampleConversationIds: idsBeforeRetry,
      exports: [exportedArtifactPath],
      exportArtifacts: [{
        path: exportedArtifactPath,
        sha256: await fileSha256(exportedArtifactPath),
      }],
      validations: {
        sourceHasPlatformColumn: false,
        pendingRecords: 4,
        historicalRowsSkipped: 1,
        partialConflictBlocked: true,
        completedRecordsWithStableIds: 3,
        reviewRecordsWithStableIds: 1,
        historicalVersionActivatedForTaskTwo: true,
        taskOneVersionStableAfterRetry: true,
        taskOneKnowledgeStableAfterRetry: true,
        taskOneRulesStableAfterRetry: true,
        imagesPreserved: true,
        stylesPreserved: true,
        formulasPreserved: true,
        rowsPreserved: true,
        placeholderPreserved: true,
        targetFieldsVerified: true,
        issueDimensionDeductionAligned: true,
        excelJsReread: "passed",
        ooxmlCompatibility: "passed",
        excelManualOpen: "requires release evidence",
        wpsManualOpen: "requires release evidence",
      },
      officialReleaseEligible: false,
      officialReleaseBlocker: "必须附加 Excel 与 WPS 人工打开证据后运行正式发布门禁",
    };
    await fs.writeFile(
      path.join(workspace, "automated-acceptance.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
  });
});
