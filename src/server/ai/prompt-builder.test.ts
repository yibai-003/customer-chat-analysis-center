import { describe, expect, it } from "vitest";
import { buildVisionMessages } from "./prompt-builder";

describe("vision prompt builder", () => {
  it("includes the prompt, source fields and image data URL", () => {
    const messages = buildVisionMessages({
      section: { id: "a", parentId: "p", name: "未成交分析", prompt: "分析原因", outputSchema: [], sortOrder: 1, isEnabled: true },
      sourceFields: { 渠道: "微信" },
      imageDataUrl: "data:image/png;base64,AAA",
    });
    expect(JSON.stringify(messages)).toContain("分析原因");
    expect(JSON.stringify(messages)).toContain("微信");
    expect(JSON.stringify(messages)).toContain("data:image/png;base64,AAA");
  });

  it("omits the image part when the section disables image analysis", () => {
    const messages = buildVisionMessages({
      section: { id: "a", parentId: "p", name: "辅助字段分析", prompt: "只根据辅助字段判断", outputSchema: [], sortOrder: 1, isEnabled: true, imageEnabled: false },
      sourceFields: { 渠道: "微信" },
      imageDataUrl: "data:image/png;base64,AAA",
    });
    expect(JSON.stringify(messages)).not.toContain("data:image/png;base64,AAA");
  });
});
