import { describe, expect, it } from "vitest";
import { quotaPresentation } from "./quota-presentation";

describe("quota presentation", () => {
  it("returns normal and warning states around the safety threshold", () => {
    expect(quotaPresentation({
      quotaUsedTokens: 800,
      quotaTotalTokens: 1000,
      quotaSafetyRatio: 0.9,
      quotaBlocked: false,
    })).toMatchObject({ kind: "finite", tone: "normal", percent: 80 });
    expect(quotaPresentation({
      quotaUsedTokens: 900,
      quotaTotalTokens: 1000,
      quotaSafetyRatio: 0.9,
      quotaBlocked: false,
    })).toMatchObject({ kind: "finite", tone: "warning", percent: 90 });
  });

  it("treats blocked, exhausted and overused quotas as exhausted", () => {
    for (const input of [
      { quotaUsedTokens: 1000, quotaTotalTokens: 1000, quotaSafetyRatio: 0.9, quotaBlocked: false },
      { quotaUsedTokens: 1200, quotaTotalTokens: 1000, quotaSafetyRatio: 0.9, quotaBlocked: false },
      { quotaUsedTokens: 200, quotaTotalTokens: 1000, quotaSafetyRatio: 0.9, quotaBlocked: true },
    ]) {
      expect(quotaPresentation(input)).toMatchObject({
        kind: "finite",
        tone: "exhausted",
        percent: input.quotaUsedTokens >= 1000 ? 100 : 20,
      });
    }
  });

  it("handles unlimited and invalid totals without throwing", () => {
    expect(quotaPresentation({
      quotaUsedTokens: 50,
      quotaTotalTokens: null,
      quotaSafetyRatio: 0.9,
      quotaBlocked: false,
    })).toMatchObject({ kind: "unlimited", tone: "unlimited", total: null });

    for (const total of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(quotaPresentation({
        quotaUsedTokens: 50,
        quotaTotalTokens: total,
        quotaSafetyRatio: 0.9,
        quotaBlocked: false,
      })).toMatchObject({ kind: "invalid", tone: "invalid", percent: 0 });
    }
  });

  it("normalizes invalid or negative usage to zero", () => {
    for (const used of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(quotaPresentation({
        quotaUsedTokens: used,
        quotaTotalTokens: 1000,
        quotaSafetyRatio: 0.9,
        quotaBlocked: false,
      })).toMatchObject({ used: 0, percent: 0, tone: "normal" });
    }
  });
});
