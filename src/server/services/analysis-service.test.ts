import { describe, expect, it, vi } from "vitest";
import { analyzeRecord } from "./analysis-service";
import { analyzeRecordFields } from "./field-analysis-service";
vi.mock("./field-analysis-service", () => ({ analyzeRecordFields: vi.fn() }));
describe("single-record outcome", () => {
  it.each([
    [0, 0, 0, "completed"], [1, 0, 2, "failed"], [0, 1, 0, "needs_review"], [0, 0, 1, "needs_review"],
  ] as const)("reports the actual field outcome", async (failed, needsReview, skipped, status) => {
    vi.mocked(analyzeRecordFields).mockResolvedValue({ total: 5, completed: 5-failed-needsReview-skipped, failed, needsReview, skipped });
    expect(await analyzeRecord("record", "section")).toMatchObject({ status, fields: { failed, needsReview, skipped } });
  });
});
