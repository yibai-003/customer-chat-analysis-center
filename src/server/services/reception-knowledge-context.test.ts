import { describe, expect, it } from "vitest";
import { buildReceptionKnowledgeContext } from "./reception-knowledge-context";

describe("buildReceptionKnowledgeContext", () => {
  it("omits whole bases at the budget boundary and always returns legal JSON", () => {
    const context = buildReceptionKnowledgeContext([
      {
        id: "small-base", name: "小库", isEnabled: true,
        items: [{ id: "small-item", isEnabled: true, values: { rule: "keep" } }],
      },
      {
        id: "large-base", name: "大库", isEnabled: true,
        items: [{ id: "large-item", isEnabled: true, values: { rule: "x".repeat(200) } }],
      },
    ] as never, 120);

    expect(() => JSON.parse(context.serialized)).not.toThrow();
    expect(JSON.parse(context.serialized)).toEqual([
      { baseId: "small-base", name: "小库", items: [{ itemId: "small-item", values: { rule: "keep" } }] },
    ]);
    expect(context.complete).toBe(false);
    expect(context.includedBaseIds).toEqual(["small-base"]);
    expect(context.omittedBaseIds).toEqual(["large-base"]);
    expect(context.omittedItemCount).toBe(1);
  });

  it("filters disabled and malformed entries while preserving snapshot order", () => {
    const context = buildReceptionKnowledgeContext([
      { id: "disabled", name: "停用", isEnabled: false, items: [{ id: "x", isEnabled: true, values: { x: 1 } }] },
      { id: "base", name: "知识", isEnabled: true, items: [
        { id: "off", isEnabled: false, values: { x: 2 } },
        { id: "bad", isEnabled: true, values: "text" },
        { id: "kept", isEnabled: true, values: { x: 3 } },
      ] },
    ] as never);

    expect(JSON.parse(context.serialized)).toEqual([
      { baseId: "base", name: "知识", items: [{ itemId: "kept", values: { x: 3 } }] },
    ]);
    expect(context.complete).toBe(true);
  });
});
