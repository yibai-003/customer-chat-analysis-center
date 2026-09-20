// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { quotaPresentation } from "./quota-presentation";
import { QuotaMeter } from "./QuotaMeter";

afterEach(cleanup);

describe("QuotaMeter", () => {
  it("renders exact finite values with progress semantics", () => {
    const { container } = render(
      <QuotaMeter
        modelName="千问视觉"
        quota={quotaPresentation({
          quotaUsedTokens: 880_685,
          quotaTotalTokens: 1_000_000,
          quotaSafetyRatio: 0.95,
          quotaBlocked: false,
        })}
      />,
    );

    expect(screen.getByText("880,685 / 1,000,000")).toBeTruthy();
    expect(screen.getAllByText("额度正常")).toHaveLength(1);
    expect(container.querySelector(".quota-meter")?.getAttribute("data-quota-state"))
      .toBe("normal");
    const progress = screen.getByRole("progressbar", { name: "千问视觉额度 88%" });
    expect(progress.getAttribute("aria-valuemin")).toBe("0");
    expect(progress.getAttribute("aria-valuenow")).toBe("880685");
    expect(progress.getAttribute("aria-valuemax")).toBe("1000000");
  });

  it("caps overused progress semantics at max while preserving exact display", () => {
    const { container } = render(
      <QuotaMeter
        modelName="超额模型"
        quota={quotaPresentation({
          quotaUsedTokens: 1_200_000,
          quotaTotalTokens: 1_000_000,
          quotaSafetyRatio: 0.95,
          quotaBlocked: false,
        })}
      />,
    );

    expect(screen.getByText("1,200,000 / 1,000,000")).toBeTruthy();
    expect(screen.getAllByText("额度已耗尽")).toHaveLength(1);
    expect(container.querySelector(".quota-meter")?.getAttribute("data-quota-state"))
      .toBe("exhausted");
    const progress = screen.getByRole("progressbar", { name: "超额模型额度 100%" });
    const now = Number(progress.getAttribute("aria-valuenow"));
    const max = Number(progress.getAttribute("aria-valuemax"));
    expect(now).toBe(1_000_000);
    expect(max).toBe(1_000_000);
    expect(now).toBeLessThanOrEqual(max);
  });

  it("renders unlimited and invalid values and statuses once without a progressbar", () => {
    const { container, rerender } = render(
      <QuotaMeter
        modelName="不限额模型"
        quota={quotaPresentation({
          quotaUsedTokens: 10,
          quotaTotalTokens: null,
          quotaSafetyRatio: 0.95,
          quotaBlocked: false,
        })}
      />,
    );

    expect(screen.getAllByText("10")).toHaveLength(1);
    expect(screen.getAllByText("不限额")).toHaveLength(1);
    expect(container.querySelector(".quota-meter")?.getAttribute("data-quota-state"))
      .toBe("unlimited");
    expect(screen.queryByRole("progressbar")).toBeNull();

    rerender(
      <QuotaMeter
        modelName="异常模型"
        quota={quotaPresentation({
          quotaUsedTokens: 10,
          quotaTotalTokens: 0,
          quotaSafetyRatio: 0.95,
          quotaBlocked: false,
        })}
      />,
    );

    expect(screen.getAllByText("10")).toHaveLength(1);
    expect(screen.getAllByText("额度数据异常")).toHaveLength(1);
    expect(container.querySelector(".quota-meter")?.getAttribute("data-quota-state"))
      .toBe("invalid");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("renders exhausted missing-total state once without a progressbar", () => {
    const { container } = render(
      <QuotaMeter
        modelName="无总额耗尽模型"
        quota={quotaPresentation({
          quotaUsedTokens: 1_200,
          quotaSafetyRatio: 0.95,
          quotaBlocked: true,
          quotaExhaustedAt: "2026-09-20T08:00:00.000Z",
        })}
      />,
    );

    expect(screen.getAllByText("1,200")).toHaveLength(1);
    expect(screen.getAllByText("额度已耗尽")).toHaveLength(1);
    expect(container.querySelector(".quota-meter")?.getAttribute("data-quota-state"))
      .toBe("exhausted");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("renders exhausted invalid-total state once without a progressbar", () => {
    const { container } = render(
      <QuotaMeter
        modelName="异常总额耗尽模型"
        quota={quotaPresentation({
          quotaUsedTokens: 50,
          quotaTotalTokens: 0,
          quotaSafetyRatio: 0.95,
          quotaBlocked: true,
          quotaExhaustedAt: "2026-09-20T08:00:00.000Z",
        })}
      />,
    );

    expect(screen.getAllByText("50")).toHaveLength(1);
    expect(screen.getAllByText("额度已耗尽")).toHaveLength(1);
    expect(container.querySelector(".quota-meter")?.getAttribute("data-quota-state"))
      .toBe("exhausted");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
