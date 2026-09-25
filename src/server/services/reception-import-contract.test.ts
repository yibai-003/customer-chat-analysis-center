import { describe, expect, it } from "vitest";
import {
  inspectReceptionResultRow,
  receptionImportConflictMessage,
} from "./reception-import-contract";

const contract = {
  imageColumn: "聊天截图",
  resultColumns: ["问题点-售前", "问题点-售后", "接待流程质检结果"],
  completeHistoricalResultRequiredColumns: [
    "问题点-售前",
    "问题点-售后",
    "接待流程质检结果",
  ],
};

describe("reception import contract", () => {
  it("classifies an empty result area as pending analysis", () => {
    expect(inspectReceptionResultRow({
      "问题点-售前": " ",
      "问题点-售后": "",
      接待流程质检结果: "",
    }, contract)).toEqual({
      status: "empty",
      filledFields: [],
      missingFields: [],
      extraFields: [],
    });
  });

  it("classifies a complete historical result without exposing its values", () => {
    expect(inspectReceptionResultRow({
      "问题点-售前": "无",
      "问题点-售后": "漏回复",
      接待流程质检结果: "B",
    }, contract)).toEqual({
      status: "complete",
      filledFields: [
        "问题点-售前",
        "问题点-售后",
        "接待流程质检结果",
      ],
      missingFields: [],
      extraFields: [],
    });
  });

  it("reports partial and illegal field combinations explicitly", () => {
    const inspection = inspectReceptionResultRow({
      "问题点-售前": "答非所问",
      "问题点-售后": "",
      接待流程质检结果: "",
      组长复检文本: "不属于结果契约",
    }, contract);

    expect(inspection).toEqual({
      status: "conflict",
      filledFields: ["问题点-售前"],
      missingFields: ["问题点-售后", "接待流程质检结果"],
      extraFields: [],
    });
    expect(receptionImportConflictMessage([{
      sheetName: "质检一",
      rowNumber: 3,
      ...inspection,
    }])).toContain("质检一 第 3 行");
    expect(receptionImportConflictMessage([{
      sheetName: "质检一",
      rowNumber: 3,
      ...inspection,
    }])).toContain("原因：结果区部分填写或字段组合不合法");
    expect(receptionImportConflictMessage([{
      sheetName: "质检一",
      rowNumber: 3,
      ...inspection,
    }])).toContain("缺失字段：问题点-售后、接待流程质检结果");
  });

  it("reports populated optional result fields as extra when required history is incomplete", () => {
    const optionalContract = {
      ...contract,
      completeHistoricalResultRequiredColumns: ["接待流程质检结果"],
    };
    expect(inspectReceptionResultRow({
      "问题点-售前": "答非所问",
      "问题点-售后": "",
      接待流程质检结果: "",
    }, optionalContract)).toEqual({
      status: "conflict",
      filledFields: ["问题点-售前"],
      missingFields: ["接待流程质检结果"],
      extraFields: ["问题点-售前"],
    });
  });
});
