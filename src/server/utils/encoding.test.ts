import { describe, expect, it } from "vitest";
import { normalizeUploadedFilename } from "./encoding";

describe("uploaded filename encoding", () => {
  it("repairs mojibake Chinese filenames", () => {
    expect(normalizeUploadedFilename("éè´§åæ_æµè¯.xlsx")).toBe("退货分析_测试.xlsx");
  });

  it("keeps valid filenames unchanged", () => {
    expect(normalizeUploadedFilename("退货分析_测试.xlsx")).toBe("退货分析_测试.xlsx");
  });
});
