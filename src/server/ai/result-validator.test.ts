import { describe, expect, it } from "vitest";
import { validateAnalysisResult, validateFieldResult } from "./result-validator";
import type { AnalysisField } from "../../shared/types";

const schema = [{ key: "reason", label: "原因", type: "string" as const, required: true }];

describe("AI result validation", () => {
  const imageField: AnalysisField = { id: "refund-reason", sectionId: "refund", key: "reason", label: "截图解析", type: "string", prompt: "", required: true, imageEnabled: true, dependsOn: [], sortOrder: 0, isEnabled: true };
  it("preserves nested screenshot facts as text while keeping evidence", () => {
    const facts = { 客户诉求: "退款", 关键词: ["损坏", "补发"], 证据: { 客服确认: true } };
    const checked = validateFieldResult(JSON.stringify({ reason: facts, evidence: "客服确认损坏" }), imageField);
    expect(checked.valid).toBe(true);
    expect(JSON.parse(checked.result.reason as string)).toEqual(facts);
    expect(checked.result.evidence).toBe("客服确认损坏");
  });
  it("does not coerce restricted options, other types, missing values or non-image fields", () => {
    const raw = '{"reason":{"事实":"退款"}}';
    expect(validateFieldResult(raw, { ...imageField, imageEnabled: false }).valid).toBe(false);
    expect(validateFieldResult(raw, { ...imageField, options: ["退款"] }).valid).toBe(false);
    expect(validateFieldResult(raw, { ...imageField, type: "number" }).valid).toBe(false);
    expect(validateFieldResult(raw, { ...imageField, type: "object" }).result.reason).toEqual({ 事实: "退款" });
    for (const invalid of ['{}', '{"reason":123}', '{"reason":[]}', '{"reason":{}}', 'invalid json']) {
      expect(validateFieldResult(invalid, imageField).valid).toBe(false);
    }
  });
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
