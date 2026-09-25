import { describe, expect, it } from "vitest";
import { ANALYSIS_EXECUTION_TYPES, type AnalysisExecutionType } from "../../../shared/types";
import {
  fieldExecutionHandler,
  registeredExecutionTypes,
  registerFieldExecutionHandler,
  type FieldExecutionInput,
} from "./registry";
import "./index";

describe("field execution registry", () => {
  it("registers a handler for every declared analysis execution type", () => {
    expect(registeredExecutionTypes().toSorted()).toEqual(ANALYSIS_EXECUTION_TYPES.toSorted());
  });

  it("rejects execution types without a registered handler", () => {
    expect(() => fieldExecutionHandler("legacy_unknown" as AnalysisExecutionType))
      .toThrow("未注册的字段执行类型：legacy_unknown");
  });

  it("dispatches a newly registered handler without scheduler changes", async () => {
    registerFieldExecutionHandler({
      type: "probe_board" as AnalysisExecutionType,
      async run() {
        return { result: { probe: "ok" }, status: "completed" };
      },
    });
    const output = await fieldExecutionHandler("probe_board" as AnalysisExecutionType)
      .run({} as FieldExecutionInput);
    expect(output.result).toEqual({ probe: "ok" });
  });
});
