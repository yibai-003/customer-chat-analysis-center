import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type CatalogField = {
  key: string;
  prompt: string;
  depends_on_json: string;
  sort_order: number;
};

describe("hot-topic catalog configuration", () => {
  it("runs customer question extraction before standard question capture", () => {
    const catalogPath = path.resolve("knowledge/catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as {
      fields: CatalogField[];
    };
    const fields = catalog.fields.filter((field) => (
      ["截图解析", "客户问题", "高频问题"].includes(field.key)
    ));
    const byKey = new Map(fields.map((field) => [field.key, field]));
    const customerQuestion = byKey.get("客户问题")!;
    const hotTopicQuestion = byKey.get("高频问题")!;
    const screenshot = byKey.get("截图解析")!;

    expect(customerQuestion.sort_order).toBeLessThan(hotTopicQuestion.sort_order);
    expect(JSON.parse(hotTopicQuestion.depends_on_json)).toEqual(["截图解析", "客户问题"]);
    expect(screenshot.prompt).not.toContain("核心问题/核心诉求");
    expect(customerQuestion.prompt).toContain("只提炼客户真实提出的问题或诉求");
    expect(customerQuestion.prompt).toContain("不生成客服答案");
  });
});
