import { describe, expect, it } from "vitest";
import { buildFieldMessages } from "./field-prompt-builder";

describe("field prompt builder", () => {
  it("sends only the target field schema and dependency values", () => {
    const messages = buildFieldMessages({
      field: {
        id: "reason",
        sectionId: "lost-deal",
        key: "一级原因",
        label: "一级原因",
        type: "string",
        prompt: "根据截图内容判断一级原因",
        required: false,
        imageEnabled: false,
        dependsOn: ["screenshotContent"],
        sortOrder: 1,
        isEnabled: true,
      },
      sectionName: "未成交分析",
      sourceFields: { 渠道: "微信" },
      dependencyResults: { screenshotContent: "客户询问价格后离开" },
      imageDataUrl: "",
    });
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain("一级原因");
    expect(serialized).toContain("客户询问价格后离开");
    expect(serialized).not.toContain("image_url");
    expect(serialized).not.toContain("聊天");
  });

  it("includes configured options in the field prompt", () => {
    const messages = buildFieldMessages({
      field: {
        id: "reason", sectionId: "lost-deal", key: "reason", label: "一级原因",
        type: "string", prompt: "选择原因", required: false, imageEnabled: false,
        dependsOn: [], sortOrder: 0, isEnabled: true, options: ["价格问题", "产品问题"],
      },
      sectionName: "未成交分析", sourceFields: {}, dependencyResults: {}, imageDataUrl: "",
    });
    expect(JSON.stringify(messages)).toContain("价格问题");
  });
});
