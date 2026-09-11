import { describe, expect, it } from "vitest";
import { normalizeImageAnchor } from "./excel-import-service";

describe("Excel image anchors", () => {
  it("stores only JSON-safe row and column coordinates", () => {
    const worksheet = { name: "客服记录" };
    const anchor = normalizeImageAnchor({
      tl: { nativeRow: 1, nativeCol: 3, worksheet },
      br: { nativeRow: 8, nativeCol: 5, worksheet },
    });
    expect(JSON.stringify(anchor)).toBe('{"startRow":2,"startColumn":4,"endRow":9,"endColumn":6}');
  });
});
