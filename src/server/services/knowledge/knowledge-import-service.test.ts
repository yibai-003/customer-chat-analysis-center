import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, initDb } from "../../db/client";
import type { KnowledgeColumn } from "../../../shared/types";
import {
  deleteKnowledgeItem,
  listKnowledgeBases,
  listKnowledgeItems,
  upsertKnowledgeBase,
  upsertKnowledgeItem,
} from "./knowledge-repository";
import {
  importKnowledgeWorkbook,
  previewKnowledgeImport,
} from "./knowledge-import-service";
import { createKnowledgeWorkbook } from "./knowledge-test-fixtures";

const sectionId = "refund";
const headers = ["一级原因", "二级原因", "三级原因"];
const columns: KnowledgeColumn[] = [
  { name: "一级原因", roles: ["result", "search"] },
  { name: "二级原因", roles: ["result", "search"] },
  { name: "三级原因", roles: ["description"] },
];

function clearKnowledgeData() {
  db.exec(`
    DELETE FROM knowledge_item_fts;
    DELETE FROM knowledge_imports;
    DELETE FROM knowledge_items;
    DELETE FROM knowledge_bases;
  `);
}

describe("knowledge workbook import", () => {
  beforeAll(() => initDb());
  beforeEach(() => clearKnowledgeData());

  it("previews dynamic headers from the first non-empty worksheet without writing data", async () => {
    const filePath = await createKnowledgeWorkbook({
      headers,
      emptyWorksheetFirst: true,
      rows: [
        ["商品问题", "破损", "外包装或商品破损"],
        ["物流问题", "超时", "承诺时间后送达"],
        ["服务问题", "态度", "客服态度不佳"],
        [null, null, null],
      ],
    });

    const preview = await previewKnowledgeImport(
      filePath,
      "首次导入.xlsx",
      sectionId,
      columns,
    );

    expect(preview.headers).toEqual(["一级原因", "二级原因", "三级原因"]);
    expect(preview.totalRows).toBe(3);
    expect(preview.added).toBe(3);
    expect(preview.errors).toEqual([]);
    expect(listKnowledgeBases(sectionId)).toEqual([]);
  });

  it("incrementally adds, updates and skips rows without deleting old entries", async () => {
    const firstPath = await createKnowledgeWorkbook({
      headers,
      rows: [
        ["商品问题", "破损", "旧说明"],
        ["物流问题", "超时", "原说明"],
        ["服务问题", "态度", "原说明"],
      ],
    });
    const first = await importKnowledgeWorkbook({
      filePath: firstPath,
      originalFilename: "首次导入.xlsx",
      sectionId,
      name: "退货原因",
      columns,
    });

    const updatedPath = await createKnowledgeWorkbook({
      headers,
      rows: [
        ["商品问题", "破损", "新说明"],
        ["物流问题", "超时", "原说明"],
        ["支付问题", "退款", "新增说明"],
      ],
    });
    const secondPreview = await previewKnowledgeImport(
      updatedPath,
      "更新导入.xlsx",
      sectionId,
      columns,
      first.knowledgeBase.id,
    );
    expect(secondPreview).toMatchObject({ added: 1, updated: 1, skipped: 1 });

    const second = await importKnowledgeWorkbook({
      filePath: updatedPath,
      originalFilename: "更新导入.xlsx",
      sectionId,
      knowledgeBaseId: first.knowledgeBase.id,
      columns,
    });

    expect(second).toMatchObject({ added: 1, updated: 1, skipped: 1 });
    expect(listKnowledgeItems(first.knowledgeBase.id).items).toHaveLength(4);
    expect(
      listKnowledgeItems(first.knowledgeBase.id).items.find(
        (item) => item.values["一级原因"] === "商品问题",
      )?.values["三级原因"],
    ).toBe("新说明");
  });

  it("rejects a role mapping change when previewing an existing knowledge base", async () => {
    const filePath = await createKnowledgeWorkbook({
      headers,
      rows: [["商品问题", "破损", "说明"]],
    });
    const first = await importKnowledgeWorkbook({
      filePath,
      originalFilename: "首次导入.xlsx",
      sectionId,
      name: "退货原因",
      columns,
    });
    const changedRoles: KnowledgeColumn[] = [
      columns[0],
      columns[1],
      { name: "三级原因", roles: ["keyword"] },
    ];

    await expect(previewKnowledgeImport(
      filePath,
      "角色变化.xlsx",
      sectionId,
      changedRoles,
      first.knowledgeBase.id,
    )).rejects.toThrow("列映射与知识库已保存映射不一致");
    expect(listKnowledgeBases(sectionId)[0].columns).toEqual(columns);
  });

  it("rejects a result-column mapping change when importing into an existing knowledge base", async () => {
    const filePath = await createKnowledgeWorkbook({
      headers,
      rows: [["商品问题", "破损", "说明"]],
    });
    const first = await importKnowledgeWorkbook({
      filePath,
      originalFilename: "首次导入.xlsx",
      sectionId,
      name: "退货原因",
      columns,
    });
    const changedResults: KnowledgeColumn[] = [
      { name: "一级原因", roles: ["result", "search"] },
      { name: "二级原因", roles: ["search"] },
      { name: "三级原因", roles: ["result", "description"] },
    ];

    await expect(importKnowledgeWorkbook({
      filePath,
      originalFilename: "结果列变化.xlsx",
      sectionId,
      knowledgeBaseId: first.knowledgeBase.id,
      columns: changedResults,
    })).rejects.toThrow("列映射与知识库已保存映射不一致");
    expect(listKnowledgeBases(sectionId)[0].columns).toEqual(columns);
  });

  it("preserves a disabled item's status when reimporting changed content", async () => {
    const firstPath = await createKnowledgeWorkbook({
      headers,
      rows: [["商品问题", "破损", "旧说明"]],
    });
    const first = await importKnowledgeWorkbook({
      filePath: firstPath,
      originalFilename: "首次导入.xlsx",
      sectionId,
      name: "退货原因",
      columns,
    });
    const item = listKnowledgeItems(first.knowledgeBase.id).items[0];
    upsertKnowledgeItem({ ...item, isEnabled: false });

    const updatedPath = await createKnowledgeWorkbook({
      headers,
      rows: [["商品问题", "破损", "新说明"]],
    });
    await importKnowledgeWorkbook({
      filePath: updatedPath,
      originalFilename: "更新导入.xlsx",
      sectionId,
      knowledgeBaseId: first.knowledgeBase.id,
    });

    const updated = listKnowledgeItems(first.knowledgeBase.id).items[0];
    expect(updated.values["三级原因"]).toBe("新说明");
    expect(updated.isEnabled).toBe(false);
  });

  it("merges duplicate paths, reports them, and ignores blank rows", async () => {
    const filePath = await createKnowledgeWorkbook({
      headers,
      rows: [
        ["商品问题", "破损", "第一条说明"],
        [null, "   ", null],
        ["商品问题", "破损", "最后一条说明"],
      ],
    });

    const preview = await previewKnowledgeImport(
      filePath,
      "重复路径.xlsx",
      sectionId,
      columns,
    );

    expect(preview).toMatchObject({
      totalRows: 2,
      added: 1,
      duplicateRows: 1,
    });

    const result = await importKnowledgeWorkbook({
      filePath,
      originalFilename: "重复路径.xlsx",
      sectionId,
      name: "重复路径",
      columns,
    });
    expect(listKnowledgeItems(result.knowledgeBase.id).items[0].values["三级原因"])
      .toBe("最后一条说明");
  });

  it("rejects duplicate headers and a mapping without result columns", async () => {
    const duplicateHeaderPath = await createKnowledgeWorkbook({
      headers: ["分类", " 分类 "],
      rows: [["A", "B"]],
    });
    await expect(
      previewKnowledgeImport(duplicateHeaderPath, "重复表头.xlsx", sectionId),
    ).rejects.toThrow("表头重复");

    const noResultPath = await createKnowledgeWorkbook({
      headers: ["关键词", "说明"],
      rows: [["破损", "商品已破损"]],
    });
    await expect(
      previewKnowledgeImport(noResultPath, "无结果列.xlsx", sectionId, [
        { name: "关键词", roles: ["keyword"] },
        { name: "说明", roles: ["description"] },
      ]),
    ).rejects.toThrow("至少配置一个结果列");
  });

  it("returns a row error when a configured child has no parent value", async () => {
    const hierarchyColumns: KnowledgeColumn[] = [
      { name: "根因", roles: ["result"] },
      { name: "细分", roles: ["result"], requiredParent: "根因" },
    ];
    const filePath = await createKnowledgeWorkbook({
      headers: ["根因", "细分"],
      rows: [[null, "后级值"], ["有效根因", "有效细分"]],
    });

    const preview = await previewKnowledgeImport(
      filePath,
      "层级错误.xlsx",
      sectionId,
      hierarchyColumns,
    );

    expect(preview.errors).toEqual([
      { rowNumber: 2, message: "列“细分”有值时，父列“根因”不能为空" },
    ]);
    expect(preview).toMatchObject({ totalRows: 2, added: 1 });
  });

  it("keeps repository data isolated by section and knowledge base", async () => {
    const refundBase = upsertKnowledgeBase({
      sectionId: "refund",
      name: "退货库",
      originalFilename: "refund.xlsx",
      columns,
      isEnabled: true,
    });
    const productBase = upsertKnowledgeBase({
      sectionId: "product",
      name: "产品库",
      originalFilename: "product.xlsx",
      columns,
      isEnabled: true,
    });
    upsertKnowledgeItem({
      knowledgeBaseId: refundBase.id,
      values: { 一级原因: "退货", 二级原因: "破损", 三级原因: "" },
      isEnabled: true,
    });
    upsertKnowledgeItem({
      knowledgeBaseId: productBase.id,
      values: { 一级原因: "产品", 二级原因: "质量", 三级原因: "" },
      isEnabled: true,
    });

    expect(listKnowledgeBases("refund").map((base) => base.id)).toEqual([refundBase.id]);
    expect(listKnowledgeItems(refundBase.id).items.map((item) => item.values["一级原因"]))
      .toEqual(["退货"]);

    const filePath = await createKnowledgeWorkbook({
      headers,
      rows: [["商品问题", "破损", "说明"]],
    });
    await expect(
      previewKnowledgeImport(
        filePath,
        "跨板块.xlsx",
        "refund",
        columns,
        productBase.id,
      ),
    ).rejects.toThrow("知识库不属于当前板块");
  });

  it("updates and deletes the FTS row in the same repository operation", () => {
    const base = upsertKnowledgeBase({
      sectionId,
      name: "FTS 测试",
      originalFilename: "fts.xlsx",
      columns,
      isEnabled: true,
    });
    const item = upsertKnowledgeItem({
      knowledgeBaseId: base.id,
      values: { 一级原因: "商品问题", 二级原因: "破损", 三级原因: "旧说明" },
      isEnabled: true,
    });
    expect(
      db.prepare("SELECT search_text FROM knowledge_item_fts WHERE item_id = ?").get(item.id),
    ).toMatchObject({ search_text: expect.stringContaining("旧说明") });

    upsertKnowledgeItem({
      ...item,
      values: { ...item.values, 三级原因: "新说明" },
    });
    const ftsRows = db.prepare(
      "SELECT search_text FROM knowledge_item_fts WHERE item_id = ?",
    ).all(item.id) as Array<{ search_text: string }>;
    expect(ftsRows).toHaveLength(1);
    expect(ftsRows[0].search_text).toContain("新说明");
    expect(ftsRows[0].search_text).not.toContain("旧说明");

    deleteKnowledgeItem(item.id);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM knowledge_item_fts WHERE item_id = ?")
        .get(item.id),
    ).toEqual({ count: 0 });
  });

  it("rolls back items, FTS rows and a new base when import history insertion fails", async () => {
    const filePath = await createKnowledgeWorkbook({
      headers,
      rows: [["商品问题", "破损", "说明"]],
    });
    db.exec(`
      CREATE TEMP TRIGGER fail_knowledge_import
      BEFORE INSERT ON knowledge_imports
      BEGIN
        SELECT RAISE(ABORT, 'history failed');
      END;
    `);

    try {
      await expect(importKnowledgeWorkbook({
        filePath,
        originalFilename: "事务失败.xlsx",
        sectionId,
        name: "事务失败",
        columns,
      })).rejects.toThrow("history failed");
    } finally {
      db.exec("DROP TRIGGER fail_knowledge_import");
    }

    expect(listKnowledgeBases(sectionId)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_items").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_item_fts").get())
      .toEqual({ count: 0 });
  });
});
