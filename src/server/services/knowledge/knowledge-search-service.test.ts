import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, initDb } from "../../db/client";
import type { KnowledgeColumn } from "../../../shared/types";
import {
  upsertKnowledgeBase,
  upsertKnowledgeItem,
} from "./knowledge-repository";
import { searchKnowledge } from "./knowledge-search-service";

const columns: KnowledgeColumn[] = [
  { name: "一级原因", roles: ["result", "search"] },
  { name: "二级原因", roles: ["result", "search"] },
  { name: "三级原因", roles: ["result", "search"] },
  { name: "关键词", roles: ["keyword"] },
];

function clearKnowledgeData() {
  db.exec(`
    DELETE FROM knowledge_item_fts;
    DELETE FROM knowledge_imports;
    DELETE FROM knowledge_items;
    DELETE FROM knowledge_bases;
  `);
}

function createBase(
  id: string,
  sectionId: string,
  isEnabled = true,
  baseColumns: KnowledgeColumn[] = columns,
) {
  return upsertKnowledgeBase({
    id,
    sectionId,
    name: `${sectionId}知识库`,
    originalFilename: `${sectionId}.xlsx`,
    columns: baseColumns,
    isEnabled,
  });
}

function createItem(
  id: string,
  knowledgeBaseId: string,
  values: Record<string, string>,
  isEnabled = true,
) {
  return upsertKnowledgeItem({
    id,
    knowledgeBaseId,
    values,
    isEnabled,
  });
}

describe("knowledge candidate search", () => {
  beforeAll(() => initDb());
  beforeEach(() => clearKnowledgeData());

  it("ranks the matching Chinese path first and isolates enabled data by knowledge base", () => {
    const base = createBase("base-refund", "refund");
    createItem("item-panel-spring", base.id, {
      一级原因: "工厂问题",
      二级原因: "品质-面板故障",
      三级原因: "弹簧片掉落",
      关键词: "面板 弹簧片",
    });
    createItem("item-slow-leak", base.id, {
      一级原因: "工厂问题",
      二级原因: "品质-漏气",
      三级原因: "慢漏气",
      关键词: "漏气",
    });
    createItem("item-disabled", base.id, {
      一级原因: "工厂问题",
      二级原因: "品质-面板故障",
      三级原因: "弹簧片松脱",
      关键词: "面板 弹簧片",
    }, false);

    const otherBase = createBase("base-other-section", "hot-topic");
    createItem("item-other-section", otherBase.id, {
      一级原因: "工厂问题",
      二级原因: "品质-面板故障",
      三级原因: "弹簧片掉落",
      关键词: "面板 弹簧片",
    });

    const candidates = searchKnowledge({
      knowledgeBaseId: base.id,
      query: "客户说面板里面的弹簧片掉了",
    });

    expect(candidates[0]).toMatchObject({
      itemId: "item-panel-spring",
      values: {
        一级原因: "工厂问题",
        二级原因: "品质-面板故障",
        三级原因: "弹簧片掉落",
      },
    });
    expect(candidates[0].score).toBeGreaterThan(0);
    expect(candidates[0].matchedText).toContain("弹簧片");
    expect(candidates.map((candidate) => candidate.itemId)).not.toContain("item-disabled");
    expect(candidates.map((candidate) => candidate.itemId)).not.toContain("item-other-section");
  });

  it("returns no candidates when the selected knowledge base is disabled", () => {
    const base = createBase("base-disabled", "refund", false);
    createItem("item-in-disabled-base", base.id, {
      一级原因: "工厂问题",
      二级原因: "品质-面板故障",
      三级原因: "弹簧片掉落",
      关键词: "面板 弹簧片",
    });

    expect(searchKnowledge({
      knowledgeBaseId: base.id,
      query: "面板弹簧片",
    })).toEqual([]);
  });

  it("uses substring fallback for short Chinese queries", () => {
    const base = createBase("base-short-query", "refund");
    createItem("item-panel", base.id, {
      一级原因: "工厂问题",
      二级原因: "品质-面板故障",
      三级原因: "开裂",
      关键词: "面板",
    });

    expect(searchKnowledge({
      knowledgeBaseId: base.id,
      query: "面板",
    })[0]?.itemId).toBe("item-panel");
  });

  it("normalizes whitespace before binding a short query to substring fallback", () => {
    const base = createBase("base-normalized-short-query", "refund");
    createItem("item-normalized-panel", base.id, {
      一级原因: "工厂问题",
      二级原因: "品质-面板故障",
      三级原因: "开裂",
      关键词: "面板",
    });

    expect(searchKnowledge({
      knowledgeBaseId: base.id,
      query: "面 板",
    })[0]?.itemId).toBe("item-normalized-panel");
  });

  it("normalizes spaces in stored search text for short-query fallback", () => {
    const base = createBase("base-spaced-search-text", "refund");
    createItem("item-spaced-panel", base.id, {
      一级原因: "工厂问题",
      二级原因: "品质问题",
      三级原因: "开裂",
      关键词: "面 板",
    });

    expect(searchKnowledge({
      knowledgeBaseId: base.id,
      query: "面板",
    })[0]?.itemId).toBe("item-spaced-panel");
  });

  it("normalizes tabs and line breaks in stored search text for fallback", () => {
    const base = createBase("base-control-whitespace", "refund");
    createItem("item-control-whitespace", base.id, {
      一级原因: "工厂问题",
      二级原因: "品质问题",
      三级原因: "开裂",
      关键词: "面\t板\r\n",
    });

    expect(searchKnowledge({
      knowledgeBaseId: base.id,
      query: "面板",
    })[0]?.itemId).toBe("item-control-whitespace");
  });

  it("normalizes ASCII case for short English-code fallback", () => {
    const base = createBase("base-short-code", "refund");
    createItem("item-short-code", base.id, {
      一级原因: "工厂问题",
      二级原因: "品质问题",
      三级原因: "开裂",
      关键词: "AB",
    });

    expect(searchKnowledge({
      knowledgeBaseId: base.id,
      query: "ab",
    })[0]?.itemId).toBe("item-short-code");
  });

  it("orders candidates with equal scores by item ID", () => {
    const base = createBase("base-stable-order", "refund");
    createItem("item-b", base.id, {
      一级原因: "工厂问题",
      二级原因: "面板故障-B",
      三级原因: "开裂-B",
      关键词: "面板",
    });
    createItem("item-a", base.id, {
      一级原因: "工厂问题",
      二级原因: "面板故障-A",
      三级原因: "开裂-A",
      关键词: "面板",
    });

    expect(searchKnowledge({
      knowledgeBaseId: base.id,
      query: "面板",
    }).map((candidate) => candidate.itemId)).toEqual(["item-a", "item-b"]);
  });

  it("uses dynamic result and keyword roles to break equal FTS scores", () => {
    const dynamicColumns: KnowledgeColumn[] = [
      { name: "问题类型", roles: ["search"] },
      { name: "责任归属", roles: ["result", "keyword"] },
    ];
    const base = createBase(
      "base-dynamic-columns",
      "refund",
      true,
      dynamicColumns,
    );
    createItem("item-logistics", base.id, {
      问题类型: "共同检索文本",
      责任归属: "物流公司",
    });
    createItem("item-factory", base.id, {
      问题类型: "共同检索文本",
      责任归属: "生产工厂",
    });

    const equalSearchText = "共同检索文本";
    const resetSearchText = db.transaction(() => {
      db.prepare(`
        UPDATE knowledge_items
        SET search_text = ?
        WHERE knowledge_base_id = ?
      `).run(equalSearchText, base.id);
      db.prepare(`
        DELETE FROM knowledge_item_fts
        WHERE knowledge_base_id = ?
      `).run(base.id);
      db.prepare(`
        INSERT INTO knowledge_item_fts (item_id, knowledge_base_id, search_text)
        SELECT id, knowledge_base_id, search_text
        FROM knowledge_items
        WHERE knowledge_base_id = ?
      `).run(base.id);
    });
    resetSearchText();

    const candidates = searchKnowledge({
      knowledgeBaseId: base.id,
      query: "共同检索文本，责任归属物流公司",
    });

    expect(candidates.map((candidate) => candidate.matchedText)).toEqual([
      equalSearchText,
      equalSearchText,
    ]);
    expect(candidates[0]).toMatchObject({
      itemId: "item-logistics",
      values: {
        问题类型: "共同检索文本",
        责任归属: "物流公司",
      },
    });
    expect(candidates[0].score).toBeGreaterThan(candidates[1].score);
  });

  it("defaults the result limit to 15 and clamps it to 5 through 30", () => {
    const base = createBase("base-limits", "refund");
    for (let index = 0; index < 35; index += 1) {
      createItem(`item-${String(index).padStart(2, "0")}`, base.id, {
        一级原因: "共同原因",
        二级原因: `共同问题-${index}`,
        三级原因: `共同描述-${index}`,
        关键词: "共同词",
      });
    }

    expect(searchKnowledge({
      knowledgeBaseId: base.id,
      query: "共同词",
    })).toHaveLength(15);
    expect(searchKnowledge({
      knowledgeBaseId: base.id,
      query: "共同词",
      limit: 1,
    })).toHaveLength(5);
    expect(searchKnowledge({
      knowledgeBaseId: base.id,
      query: "共同词",
      limit: 100,
    })).toHaveLength(30);
  });
});
