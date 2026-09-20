import { describe, expect, it } from "vitest";
import { formatQuotaTokens, quotaPresentation } from "./quota-presentation";

describe("quota presentation", () => {
  it("returns normal and warning states around the safety threshold", () => {
    expect(quotaPresentation({
      quotaUsedTokens: 800,
      quotaTotalTokens: 1000,
      quotaSafetyRatio: 0.9,
      quotaBlocked: false,
    })).toMatchObject({
      kind: "finite",
      tone: "normal",
      remaining: 200,
      percent: 80,
      progressValue: 800,
      statusText: "额度正常",
    });
    expect(quotaPresentation({
      quotaUsedTokens: 900,
      quotaTotalTokens: 1000,
      quotaSafetyRatio: 0.9,
      quotaBlocked: true,
    })).toMatchObject({
      kind: "finite",
      tone: "warning",
      remaining: 100,
      percent: 90,
      progressValue: 900,
      statusText: "接近安全阈值",
    });
  });

  it("treats a quota block without exhaustion evidence as warning", () => {
    expect(quotaPresentation({
      quotaUsedTokens: 200,
      quotaTotalTokens: 1000,
      quotaSafetyRatio: 0.9,
      quotaBlocked: true,
    })).toMatchObject({
      kind: "finite",
      tone: "warning",
      statusText: "接近安全阈值",
    });
  });

  it("uses exhaustion evidence while preserving exact overuse", () => {
    expect(quotaPresentation({
      quotaUsedTokens: 200,
      quotaTotalTokens: 1000,
      quotaSafetyRatio: 0.9,
      quotaBlocked: false,
      quotaExhaustedAt: "2026-09-20T08:00:00.000Z",
    })).toMatchObject({
      kind: "finite",
      tone: "exhausted",
      statusText: "额度已耗尽",
    });

    expect(quotaPresentation({
      quotaUsedTokens: 1000,
      quotaTotalTokens: 1000,
      quotaSafetyRatio: 0.9,
      quotaBlocked: false,
    })).toMatchObject({
      kind: "finite",
      tone: "exhausted",
      remaining: 0,
      percent: 100,
      progressValue: 1000,
      statusText: "额度已耗尽",
    });

    expect(quotaPresentation({
      quotaUsedTokens: 1200,
      quotaTotalTokens: 1000,
      quotaSafetyRatio: 0.9,
      quotaBlocked: false,
    })).toMatchObject({
      kind: "finite",
      tone: "exhausted",
      used: 1200,
      remaining: 0,
      percent: 100,
      progressValue: 1000,
      statusText: "额度已耗尽",
    });
  });

  it("handles null and undefined totals as unlimited", () => {
    for (const input of [
      {
        quotaUsedTokens: 50,
        quotaTotalTokens: null,
        quotaSafetyRatio: 0.9,
        quotaBlocked: false,
      },
      {
        quotaUsedTokens: 50,
        quotaSafetyRatio: 0.9,
        quotaBlocked: false,
      },
    ]) {
      expect(quotaPresentation(input)).toMatchObject({
        kind: "unlimited",
        tone: "unlimited",
        total: null,
        remaining: null,
        percent: 0,
        progressValue: 0,
        statusText: "不限额",
      });
    }
  });

  it("preserves exhaustion status when the total is unavailable", () => {
    expect(quotaPresentation({
      quotaUsedTokens: 1200,
      quotaSafetyRatio: 0.9,
      quotaBlocked: false,
      quotaExhaustedAt: "2026-09-20T08:00:00.000Z",
    })).toMatchObject({
      kind: "unlimited",
      tone: "exhausted",
      used: 1200,
      total: null,
      remaining: null,
      percent: 0,
      progressValue: 0,
      statusText: "额度已耗尽",
    });
  });

  it("handles invalid totals without throwing", () => {
    for (const total of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(quotaPresentation({
        quotaUsedTokens: 50,
        quotaTotalTokens: total,
        quotaSafetyRatio: 0.9,
        quotaBlocked: false,
      })).toMatchObject({
        kind: "invalid",
        tone: "invalid",
        total: null,
        remaining: null,
        percent: 0,
        progressValue: 0,
        statusText: "额度数据异常",
      });
    }
  });

  it("preserves exhaustion status when the total is invalid", () => {
    expect(quotaPresentation({
      quotaUsedTokens: 50,
      quotaTotalTokens: 0,
      quotaSafetyRatio: 0.9,
      quotaBlocked: false,
      quotaExhaustedAt: "2026-09-20T08:00:00.000Z",
    })).toMatchObject({
      kind: "invalid",
      tone: "exhausted",
      used: 50,
      total: null,
      remaining: null,
      percent: 0,
      progressValue: 0,
      statusText: "额度已耗尽",
    });
  });

  it("normalizes invalid or negative usage to zero", () => {
    for (const used of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(quotaPresentation({
        quotaUsedTokens: used,
        quotaTotalTokens: 1000,
        quotaSafetyRatio: 0.9,
        quotaBlocked: false,
      })).toMatchObject({ used: 0, percent: 0, progressValue: 0, tone: "normal" });
    }
  });

  it("formats token values after safe normalization", () => {
    expect(formatQuotaTokens(1234567)).toBe("1,234,567");
    expect(formatQuotaTokens(-1)).toBe("0");
    expect(formatQuotaTokens(Number.NaN)).toBe("0");
    expect(formatQuotaTokens(Number.POSITIVE_INFINITY)).toBe("0");
  });
});
