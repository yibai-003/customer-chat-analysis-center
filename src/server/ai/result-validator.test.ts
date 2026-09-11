import { describe, expect, it } from "vitest";
import { validateAnalysisResult } from "./result-validator";

const schema = [{ key: "reason", label: "原因", type: "string" as const, required: true }];

describe("AI result validation", () => {
  it("accepts a JSON object with required fields", () => {
    expect(validateAnalysisResult('{"reason":"价格原因"}', schema).valid).toBe(true);
  });

  it("accepts structured object fields", () => {
    expect(validateAnalysisResult('{"reason":{"问题现象":"未说明"}}', [{
      key: "reason", label: "截图解析", type: "object", required: true,
    }]).valid).toBe(true);
  });

  it("extracts JSON from a fenced response", () => {
    expect(validateAnalysisResult('```json\n{"reason":"库存原因"}\n```', schema).result).toEqual({ reason: "库存原因" });
  });

  it("marks invalid output for review", () => {
    expect(validateAnalysisResult("无法判断", schema).valid).toBe(false);
  });

  it("rejects values that do not match the field type", () => {
    expect(validateAnalysisResult('{"reason":123}', schema).error).toContain("类型");
    expect(validateAnalysisResult('{"score":"高"}', [{ key: "score", label: "分数", type: "number" }]).valid).toBe(false);
  });

  it("rejects values outside configured options", () => {
    const result = validateAnalysisResult('{"reason":"物流问题"}', [{
      key: "reason", label: "原因", type: "string", options: ["价格问题", "产品问题"],
    }]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("可选值");
  });
});
