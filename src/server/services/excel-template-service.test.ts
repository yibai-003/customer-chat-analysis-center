import { describe, expect, it } from "vitest";
import { buildOutputPlan, mergeTemplateHeaders } from "./excel-template-service";

describe("Excel template field mapping", () => {
  it("writes mapped fields to existing headers and appends missing headers", () => {
    const plan = buildOutputPlan(
      ["店铺名称", "一级选项", "截图解析"],
      [
        { key: "level1", label: "一级原因", outputColumn: "一级选项" },
        { key: "analysis", label: "截图分析", outputColumn: "截图分析" },
      ],
    );
    expect(plan).toEqual([
      { key: "level1", column: 2, header: "一级选项" },
      { key: "analysis", column: 4, header: "截图分析" },
    ]);
  });

  it("keeps imported headers first and appends only configured export fields", () => {
    expect(buildOutputPlan(["店铺名称", "截图解析"], [
      { key: "reason", label: "截图解析", outputColumn: "截图解析", exportEnabled: true },
      { key: "level1", label: "一级选项", outputColumn: "一级选项", exportEnabled: true },
      { key: "internal", label: "内部匹配", outputColumn: "", exportEnabled: false },
    ])).toEqual([
      { key: "reason", column: 2, header: "截图解析" },
      { key: "level1", column: 3, header: "一级选项" },
    ]);
  });

  it("merges imported template headers after existing section headers", () => {
    expect(mergeTemplateHeaders(["售后问题类型", "商品信息"], ["店铺名称", "商品信息", "截图解析"]))
      .toEqual(["售后问题类型", "商品信息", "店铺名称", "截图解析"]);
  });

  it("matches output columns after trimming accidental header whitespace", () => {
    expect(buildOutputPlan(
      ["平台", "接待流程质检结果 ", "优化建议-售前"],
      [
        { key: "quality", label: "接待流程质检结果", outputColumn: "接待流程质检结果" },
        { key: "suggestion", label: "优化建议-售前", outputColumn: "优化建议-售前" },
      ],
    )).toEqual([
      { key: "quality", column: 2, header: "接待流程质检结果" },
      { key: "suggestion", column: 3, header: "优化建议-售前" },
    ]);
  });
});
