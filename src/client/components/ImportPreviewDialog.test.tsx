// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbookPreview } from "../../shared/types";
import { ImportPreviewDialog } from "./ImportPreviewDialog";

let host: HTMLDivElement;
let root: Root;

const preview: WorkbookPreview = {
  originalFilename: "接待质检.xlsx",
  sheetCount: 1,
  imageCount: 2,
  sectionName: "接待流程质检",
  sectionVersionNumber: 3,
  platformName: "测试平台",
  platformCode: "TEST",
  pendingRecordCount: 1,
  historicalResultCount: 1,
  platformConflicts: [],
  resultConflicts: [],
  missingHeaders: [],
  sheets: [{
    name: "质检明细",
    headers: ["平台", "聊天截图"],
    imageCount: 2,
    imageRows: [2, 3],
  }],
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("ImportPreviewDialog", () => {
  it("shows pending and historical row counts", async () => {
    await act(async () => root.render(<ImportPreviewDialog preview={preview} onConfirm={vi.fn()} onCancel={vi.fn()} busy={false} />));
    expect(host.textContent).toContain("本次将创建 1 条待分析记录");
    expect(host.textContent).toContain("跳过 1 条完整历史结果");
  });

  it("shows row-level result conflicts and blocks confirmation", async () => {
    const onConfirm = vi.fn();
    await act(async () => root.render(<ImportPreviewDialog
      preview={{
        ...preview,
        resultConflicts: [{
          sheetName: "质检明细",
          rowNumber: 3,
          status: "conflict",
          filledFields: ["问题点-售前"],
          missingFields: ["接待流程质检结果"],
          extraFields: [],
        }],
      }}
      onConfirm={onConfirm}
      onCancel={vi.fn()}
      busy={false}
    />));

    expect(host.textContent).toContain("结果区冲突（1 行）");
    expect(host.textContent).toContain("质检明细 第 3 行");
    expect(host.textContent).toContain("缺失：接待流程质检结果");
    const confirm = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "确认导入 →")!;
    expect(confirm.disabled).toBe(true);
    await act(async () => confirm.click());
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
