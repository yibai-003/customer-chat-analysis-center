import { describe, expect, it } from "vitest";
import { buildKnowledgeMatchMessages } from "./knowledge-match-prompt-builder";

describe("knowledge match prompt builder", () => {
  it("offers only supplied candidate IDs and compact values", () => {
    const messages = buildKnowledgeMatchMessages({
      sectionName: "退货分析",
      fieldPrompt: "根据客户描述选择退货原因",
      dependencies: { 聊天内容: "面板里的弹簧片掉了" },
      candidates: [
        {
          itemId: "candidate-panel",
          values: {
            一级原因: "工厂问题",
            二级原因: "品质-面板故障",
          },
          score: 42,
          matchedText: "INTERNAL_MATCHED_TEXT",
        },
      ],
    });

    const serialized = JSON.stringify(messages);
    expect(serialized).toContain("candidate-panel");
    expect(serialized).toContain("品质-面板故障");
    expect(serialized).toContain("面板里的弹簧片掉了");
    expect(serialized).not.toContain("disabled-item");
    expect(serialized).not.toContain("INTERNAL_MATCHED_TEXT");
    expect(serialized).not.toContain("\"score\"");
  });

  it("requires a candidate ID or an empty ID in the only legal JSON shape", () => {
    const messages = buildKnowledgeMatchMessages({
      sectionName: "退货分析",
      fieldPrompt: "选择最匹配条目",
      dependencies: {},
      candidates: [{
        itemId: "candidate-only",
        values: { 原因: "物流破损" },
        score: 10,
        matchedText: "物流破损",
      }],
    });

    const content = messages.map((message) => message.content).join("\n");
    expect(content).toContain('{"knowledgeItemId":"candidate-id"}');
    expect(content).toContain('{"knowledgeItemId":""}');
    expect(content).toContain("candidate-only");
    expect(content).toContain("只能");
  });
});
