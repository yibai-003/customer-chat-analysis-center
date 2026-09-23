import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initDb } from "../db/client";
import {
  createImportJob,
  createPlatform,
  getSection,
  listJobs,
  listRecords,
} from "../db/repositories";
import {
  importWorkbookStreaming,
  previewWorkbookStreaming,
} from "./streaming-xlsx-import-service";

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const generatedPaths: string[] = [];
const resultHeaders = [
  "问题点-售前",
  "问题点-售后",
  "有无违规-售后",
  "客服问题 识别问题并打标签",
  "接待流程质检结果",
  "优化建议-售前",
];
const headers = ["平台", "订单号", "聊天截图", ...resultHeaders, "无关备注"];

beforeAll(() => initDb());

afterEach(async () => {
  await Promise.all(generatedPaths.splice(0).map((target) =>
    fs.rm(target, { recursive: true, force: true })));
});

function receptionSectionInput() {
  const section = getSection("reception")!;
  return {
    id: section.id,
    name: section.name,
    sourceFields: section.sourceFields,
    sectionConfigVersionId: section.currentVersionId!,
    sectionVersionNumber: section.currentVersionNumber!,
  };
}

function addScreenshot(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  useTwoCellAnchor = false,
) {
  const imageId = workbook.addImage({ base64: pixel, extension: "png" });
  if (useTwoCellAnchor) {
    sheet.addImage(imageId, {
      tl: { col: 2, row: rowNumber - 1 },
      br: { col: 3, row: rowNumber },
      editAs: "oneCell",
    } as any);
  } else {
    sheet.addImage(imageId, {
      tl: { col: 2, row: rowNumber - 1 },
      ext: { width: 20, height: 20 },
    });
  }
}

async function writeWorkbook(
  name: string,
  configure: (workbook: ExcelJS.Workbook) => void,
) {
  const file = path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random()}.xlsx`);
  generatedPaths.push(file);
  const workbook = new ExcelJS.Workbook();
  configure(workbook);
  await workbook.xlsx.writeFile(file);
  return file;
}

describe("reception template import contract", () => {
  it("automatically binds a queued reception import task to the current published version", () => {
    const section = getSection("reception")!;
    const platform = createPlatform({
      name: "接待任务版本平台",
      code: `BIND${Date.now()}`,
    });

    const importJob = createImportJob({
      filename: "自动绑定.xlsx",
      sourcePath: "pending-upload.xlsx",
      sectionId: section.id,
      sectionName: section.name,
      platform,
    });

    expect(importJob).toMatchObject({
      sectionId: "reception",
      sectionConfigVersionId: section.currentVersionId,
      platformId: platform.id,
    });
  });

  it("creates records only for empty-result screenshot rows and preserves the original workbook", async () => {
    const platform = createPlatform({
      name: "接待导入平台",
      code: `RECEPTION${Date.now()}`,
    });
    const file = await writeWorkbook("reception-contract", (workbook) => {
      const first = workbook.addWorksheet("质检一");
      first.addRow(headers);
      first.addRow([platform.name, "pending", "", "", "", "", "", "", "", "保留"]);
      first.addRow([
        platform.name,
        "historical",
        "",
        "无",
        "漏回复",
        "无违规",
        "漏回复",
        "B",
        "及时回应",
        "历史行",
      ]);
      first.addRow(["", "placeholder", "", "", "", "", "", "", "", "无图预留"]);
      addScreenshot(workbook, first, 2, true);
      addScreenshot(workbook, first, 3);

      const second = workbook.addWorksheet("质检二");
      second.addRow(headers);
      second.addRow([platform.code, "second-pending", "", "", "", "", "", "", "", "第二表"]);
      addScreenshot(workbook, second, 2);

      const decorative = workbook.addImage({ base64: pixel, extension: "png" });
      second.addImage(decorative, {
        tl: { col: 0, row: 3 },
        ext: { width: 20, height: 20 },
      });
    });
    const sourceBytes = await fs.readFile(file);

    const preview = await previewWorkbookStreaming(
      file,
      "接待质检.xlsx",
      receptionSectionInput(),
      platform,
    );
    expect(preview).toMatchObject({
      imageCount: 3,
      pendingRecordCount: 2,
      historicalResultCount: 1,
      resultConflicts: [],
    });
    expect(preview.sheets).toEqual([
      expect.objectContaining({
        name: "质检一",
        imageCount: 2,
        imageRows: [2, 3],
      }),
      expect.objectContaining({
        name: "质检二",
        imageCount: 1,
        imageRows: [2],
      }),
    ]);

    const created = await importWorkbookStreaming(
      file,
      "接待质检.xlsx",
      receptionSectionInput(),
      undefined,
      platform,
    );
    generatedPaths.push(path.dirname(created.sourcePath));

    expect(created).toMatchObject({
      totalRecords: 2,
      sectionConfigVersionId: receptionSectionInput().sectionConfigVersionId,
      platformId: platform.id,
    });
    const records = listRecords(created.id);
    expect(records.map((record) => [record.sheetName, record.rowNumber])).toEqual([
      ["质检一", 2],
      ["质检二", 2],
    ]);
    for (const record of records) {
      expect(record.status).toBe("pending");
      expect(record.conversationId).toBeNull();
      for (const field of resultHeaders) expect(record.sourceFields).not.toHaveProperty(field);
    }
    expect(records[0].sourceFields).toMatchObject({
      平台: platform.name,
      订单号: "pending",
      无关备注: "保留",
    });
    expect(await fs.readFile(created.sourcePath)).toEqual(sourceBytes);
  });

  it("rejects a conflicting non-empty platform value on a row without an image", async () => {
    const platform = createPlatform({
      name: "接待全行平台校验",
      code: `ALLROWS${Date.now()}`,
    });
    const file = await writeWorkbook("reception-platform-placeholder-conflict", (workbook) => {
      const sheet = workbook.addWorksheet("平台冲突");
      sheet.addRow(headers);
      sheet.addRow([platform.name, "pending", "", "", "", "", "", "", "", "截图行"]);
      sheet.addRow(["错误平台", "placeholder", "", "", "", "", "", "", "", "无图预留"]);
      addScreenshot(workbook, sheet, 2);
    });

    const preview = await previewWorkbookStreaming(
      file,
      "无图片行平台冲突.xlsx",
      receptionSectionInput(),
      platform,
    );
    expect(preview.platformConflicts).toEqual([
      { sheetName: "平台冲突", rowNumber: 3, value: "错误平台" },
    ]);

    const jobsBefore = listJobs().length;
    await expect(importWorkbookStreaming(
      file,
      "无图片行平台冲突.xlsx",
      receptionSectionInput(),
      undefined,
      platform,
    )).rejects.toThrow(/平台冲突 第 3 行“错误平台”/);
    expect(listJobs()).toHaveLength(jobsBefore);
  });

  it("supports encoded headers and WPS images whose serialized anchor column drifted", async () => {
    const platform = createPlatform({
      name: "京东",
      code: `JD${Date.now()}`,
    });
    const encodedHeaders = [
      "平台 (platform_name)",
      "店铺 (store_name)",
      "业务日期 (business_date)",
      "会话开始时间 (conversation_started_at)",
      "客服 (agent_name)",
      "分组 (agent_group)",
      "客户ID (customer_id)",
      "会话ID (conversation_id)",
      "对话轮数 (turn_count)",
      "等级 (rating)",
      "合计扣分 (total_deduction)",
      "优化建议 (improvement_advice)",
      "是否待人工复核 (needs_manual_review)",
      "聊天截图 (chat_screenshot)",
      "维度 (dimension)",
      "问题 (issue)",
      "扣分 (deduction)",
      "是否D级 (d_level)",
      "聊天原文 (chat_excerpt)",
      "证据说明 (evidence)",
      "判定理由 (judgement_reason)",
    ];
    const file = await writeWorkbook("reception-encoded-wps", (workbook) => {
      const sheet = workbook.addWorksheet("接待质检");
      sheet.addRow(encodedHeaders);
      sheet.addRow(["京东", "测试店铺", "2026-09-23", "", "客服甲", "一组", "C-1"]);
      const imageId = workbook.addImage({ base64: pixel, extension: "png" });
      sheet.addImage(imageId, {
        tl: { col: 8, row: 1 },
        ext: { width: 20, height: 20 },
      });
    });

    const preview = await previewWorkbookStreaming(
      file,
      "接待质检-编码表头.xlsx",
      receptionSectionInput(),
      platform,
    );
    expect(preview).toMatchObject({
      imageCount: 1,
      pendingRecordCount: 1,
      historicalResultCount: 0,
      resultConflicts: [],
      platformConflicts: [],
      missingHeaders: [],
    });
    expect(preview.sheets[0].imageRows).toEqual([2]);
  });

  it("rejects all partial result rows together before creating a task", async () => {
    const platform = createPlatform({
      name: "接待冲突平台",
      code: `CONFLICT${Date.now()}`,
    });
    const file = await writeWorkbook("reception-conflicts", (workbook) => {
      const first = workbook.addWorksheet("冲突一");
      first.addRow(headers);
      first.addRow([platform.name, "partial-1", "", "答非所问", "", "", "", "", "", ""]);
      addScreenshot(workbook, first, 2);

      const second = workbook.addWorksheet("冲突二");
      second.addRow(headers);
      second.addRow([platform.name, "partial-2", "", "", "", "", "", "C", "", ""]);
      addScreenshot(workbook, second, 2, true);
    });
    const before = listJobs().length;

    const preview = await previewWorkbookStreaming(
      file,
      "冲突.xlsx",
      receptionSectionInput(),
      platform,
    );
    expect(preview.resultConflicts).toHaveLength(2);

    await expect(importWorkbookStreaming(
      file,
      "冲突.xlsx",
      receptionSectionInput(),
      undefined,
      platform,
    )).rejects.toThrow(/冲突一 第 2 行.*缺失字段.*冲突二 第 2 行/s);
    expect(listJobs()).toHaveLength(before);
  });
});
