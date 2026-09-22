// @vitest-environment jsdom
import fs from "node:fs";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { Detail } from "../../App";
import type {
  AnalysisField,
  AnalysisSection,
  KnowledgeBase,
  KnowledgeCandidate,
  KnowledgeColumn,
  KnowledgeImportPreview,
  KnowledgeItem,
  KnowledgeItemPage,
  RecordDetail,
} from "../../../shared/types";
import type { KnowledgeApiClient } from "../../api/knowledge-api";
import { KnowledgeBaseList } from "./KnowledgeBaseList";
import { KnowledgeImportDialog } from "./KnowledgeImportDialog";
import { KnowledgeItemList } from "./KnowledgeItemList";
import { KnowledgeSearchTest } from "./KnowledgeSearchTest";
import { KnowledgeWorkspace } from "./KnowledgeWorkspace";

const columns: KnowledgeColumn[] = [
  { name: "一级原因", roles: ["result", "search"] },
  { name: "二级原因", roles: ["result", "keyword"], requiredParent: "一级原因" },
  { name: "说明", roles: ["description"] },
];

const section: AnalysisSection = {
  id: "refund",
  parentId: "after-sales",
  name: "退款售后",
  prompt: "",
  outputSchema: [],
  sortOrder: 1,
  isEnabled: true,
};

const base: KnowledgeBase = {
  id: "base-1",
  sectionId: section.id,
  name: "退款原因库",
  originalFilename: "refund.xlsx",
  columns,
  itemCount: 2,
  isEnabled: true,
  createdAt: "2026-09-09T08:00:00.000Z",
  updatedAt: "2026-09-09T09:00:00.000Z",
};

const item: KnowledgeItem = {
  id: "item-1",
  knowledgeBaseId: base.id,
  values: { 一级原因: "商品问题", 二级原因: "破损", 说明: "外包装破损" },
  isEnabled: true,
  sourceRowNumber: 2,
  updatedAt: "2026-09-09T09:00:00.000Z",
};

let host: HTMLDivElement;
let root: Root;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createApi(overrides: Partial<KnowledgeApiClient> = {}): KnowledgeApiClient {
  return {
    listBases: vi.fn().mockResolvedValue([base]),
    previewImport: vi.fn(),
    confirmImport: vi.fn(),
    updateBase: vi.fn(),
    deleteBase: vi.fn(),
    listItems: vi.fn().mockResolvedValue({
      items: [item],
      total: 1,
      page: 1,
      pageSize: 25,
    } satisfies KnowledgeItemPage),
    createItem: vi.fn(),
    updateItem: vi.fn().mockResolvedValue(item),
    deleteItem: vi.fn(),
    search: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

async function renderUi(element: ReactElement) {
  await act(async () => {
    root.render(element);
  });
}

function namedButton(name: string): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((candidate) => (
    candidate.getAttribute("aria-label") === name
    || candidate.textContent?.trim() === name
  ));
  if (!button) throw new Error(`Button not found: ${name}\n${host.innerHTML}`);
  return button;
}

function namedControl(name: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const labelled = host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    `[aria-label="${name}"]`,
  );
  if (labelled) return labelled;
  const label = [...host.querySelectorAll("label")].find((candidate) => (
    candidate.querySelector(":scope > span")?.textContent?.trim().startsWith(name)
    || candidate.childNodes[0]?.textContent?.trim() === name
  ));
  const control = label?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    "input, textarea, select",
  );
  if (!control) throw new Error(`Control not found: ${name}\n${host.innerHTML}`);
  return control;
}

function importConfirmButton(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(".knowledge-import-modal .modal-actions .button.dark");
  if (!button) throw new Error(`Import confirm button not found\n${host.innerHTML}`);
  return button;
}

function exactText(text: string): Element | undefined {
  return [...host.querySelectorAll("*")].find((element) => (
    element.textContent?.trim() === text
  ));
}

async function waitFor(assertion: () => void, timeout = 2000) {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeout) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
  throw lastError;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function change(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  await act(async () => {
    const prototype = element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("knowledge workspace", () => {
  it("opens the current section knowledge workspace from App and returns", async () => {
    const payloads: Record<string, unknown> = {
      "/api/auth/me": { user: { id: "admin-1", organizationId: "org-default", username: "admin", displayName: "测试管理员", role: "admin", isEnabled: true, createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" }, capabilities: ["task:view", "task:import", "task:analyze", "task:delete", "task:export", "review:save", "config:manage", "admin:manage", "audit:view"] },
      "/api/jobs": [],
      "/api/sections": [
        { ...section, id: "after-sales", parentId: null, name: "售后分析", sortOrder: 0 },
        section,
      ],
      "/api/model-configs": [],
      "/api/sections/refund/fields": [],
      "/api/sections/refund/knowledge-bases": [],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => ({ success: true, data: payloads[String(input)] ?? [] }),
    })));

    await renderUi(<App />);
    await waitFor(() => expect(namedButton("打开退款售后知识库")).toBeTruthy());
    await click(namedButton("打开退款售后知识库"));
    await waitFor(() => expect(exactText("退款售后知识库")).toBeTruthy());

    await click(namedButton("返回解析工作区"));
    expect(exactText("退款售后知识库")).toBeUndefined();
  });

  it("renders import counts and submits multi-role column mapping", async () => {
    const preview: KnowledgeImportPreview = {
      token: "preview-token",
      headers: ["一级原因", "二级原因", "说明"],
      totalRows: 8,
      added: 4,
      updated: 2,
      skipped: 1,
      duplicateRows: 1,
      errors: [],
    };
    const api = createApi({
      listBases: vi.fn().mockResolvedValue([]),
      previewImport: vi.fn().mockResolvedValue(preview),
      confirmImport: vi.fn().mockResolvedValue({
        knowledgeBase: base,
        added: 4,
        updated: 2,
        skipped: 1,
      }),
    });
    await renderUi(<KnowledgeWorkspace section={section} onBack={vi.fn()} apiClient={api} />);
    await waitFor(() => expect(namedButton("导入知识库")).toBeTruthy());

    await click(namedButton("导入知识库"));
    const input = namedControl("选择 Excel 文件") as HTMLInputElement;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["xlsx"], "refund.xlsx")],
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => expect(exactText("新增 4")).toBeTruthy());
    expect(exactText("更新 2")).toBeTruthy();
    expect(exactText("跳过 1")).toBeTruthy();
    expect(exactText("错误 0")).toBeTruthy();

    await click(namedControl("说明 搜索列"));
    await change(namedControl("二级原因 父列约束"), "一级原因");
    await click(namedButton("确认导入"));

    await waitFor(() => expect(api.confirmImport).toHaveBeenCalled());
    const submitted = vi.mocked(api.confirmImport).mock.calls[0][2];
    expect(submitted.find((column) => column.name === "说明")?.roles)
      .toEqual(expect.arrayContaining(["description", "search"]));
    expect(submitted.find((column) => column.name === "二级原因")?.requiredParent)
      .toBe("一级原因");
  });

  it("blocks import confirmation when preview rows contain errors", async () => {
    const api = createApi({
      previewImport: vi.fn().mockResolvedValue({
        token: "invalid-preview",
        headers: ["一级原因"],
        totalRows: 1,
        added: 0,
        updated: 0,
        skipped: 0,
        duplicateRows: 0,
        errors: [{ rowNumber: 2, message: "父列不能为空" }],
      }),
    });
    await renderUi(<KnowledgeImportDialog
      sectionId={section.id}
      apiClient={api}
      onClose={vi.fn()}
      onImported={vi.fn()}
    />);

    const input = namedControl("选择 Excel 文件") as HTMLInputElement;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["xlsx"], "invalid.xlsx")],
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => expect(host.textContent).toContain("请修正 Excel 后重新预览"));
    expect(namedButton("确认导入").disabled).toBe(true);
    await click(namedButton("确认导入"));
    expect(api.confirmImport).not.toHaveBeenCalled();
  });

  it("clears a successful preview when the next file inspection fails", async () => {
    const failed = deferred<KnowledgeImportPreview>();
    const api = createApi({
      previewImport: vi.fn()
        .mockResolvedValueOnce({
          token: "preview-a",
          headers: ["一级原因"],
          totalRows: 3,
          added: 3,
          updated: 0,
          skipped: 0,
          duplicateRows: 0,
          errors: [],
        })
        .mockReturnValueOnce(failed.promise),
    });
    await renderUi(<KnowledgeImportDialog
      sectionId={section.id}
      apiClient={api}
      onClose={vi.fn()}
      onImported={vi.fn()}
    />);

    const input = namedControl("选择 Excel 文件") as HTMLInputElement;
    const fileA = new File(["a"], "a.xlsx");
    Object.defineProperty(input, "files", { configurable: true, value: [fileA] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await waitFor(() => expect(exactText("新增 3")).toBeTruthy());
    expect(namedButton("确认导入").disabled).toBe(false);

    const fileB = new File(["b"], "b.xlsx");
    Object.defineProperty(input, "files", { configurable: true, value: [fileB] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(importConfirmButton().disabled).toBe(true);
    expect(host.textContent).not.toContain("新增 3");

    await act(async () => failed.reject(new Error("B 文件解析失败")));
    await waitFor(() => expect(host.textContent).toContain("B 文件解析失败"));
    expect(importConfirmButton().disabled).toBe(true);
    await click(importConfirmButton());
    expect(api.confirmImport).not.toHaveBeenCalled();
  });

  it("does not let an older file preview overwrite the current file", async () => {
    const previewA = deferred<KnowledgeImportPreview>();
    const api = createApi({
      previewImport: vi.fn()
        .mockReturnValueOnce(previewA.promise)
        .mockResolvedValueOnce({
          token: "preview-b",
          headers: ["B列"],
          totalRows: 2,
          added: 2,
          updated: 0,
          skipped: 0,
          duplicateRows: 0,
          errors: [],
        }),
    });
    await renderUi(<KnowledgeImportDialog
      sectionId={section.id}
      apiClient={api}
      onClose={vi.fn()}
      onImported={vi.fn()}
    />);

    const input = namedControl("选择 Excel 文件") as HTMLInputElement;
    const fileA = new File(["a"], "a.xlsx");
    Object.defineProperty(input, "files", { configurable: true, value: [fileA] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));

    const fileB = new File(["b"], "b.xlsx");
    Object.defineProperty(input, "files", { configurable: true, value: [fileB] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await waitFor(() => expect(host.textContent).toContain("B列"));

    await act(async () => previewA.resolve({
      token: "preview-a",
      headers: ["A列"],
      totalRows: 9,
      added: 9,
      updated: 0,
      skipped: 0,
      duplicateRows: 0,
      errors: [],
    }));
    expect(host.textContent).toContain("B列");
    expect(host.textContent).not.toContain("A列");
    expect(exactText("新增 2")).toBeTruthy();
    expect(exactText("新增 9")).toBeUndefined();
  });

  it("locks inspection and dialog controls while confirming an import", async () => {
    const confirmation = deferred<{
      knowledgeBase: KnowledgeBase;
      added: number;
      updated: number;
      skipped: number;
    }>();
    const result = {
      knowledgeBase: base,
      added: 3,
      updated: 0,
      skipped: 0,
    };
    const onClose = vi.fn();
    const onImported = vi.fn();
    const api = createApi({
      previewImport: vi.fn().mockResolvedValue({
        token: "preview-a",
        headers: ["一级原因"],
        totalRows: 3,
        added: 3,
        updated: 0,
        skipped: 0,
        duplicateRows: 0,
        errors: [],
      }),
      confirmImport: vi.fn().mockReturnValue(confirmation.promise),
    });
    await renderUi(<KnowledgeImportDialog
      sectionId={section.id}
      apiClient={api}
      onClose={onClose}
      onImported={onImported}
    />);

    const input = namedControl("选择 Excel 文件") as HTMLInputElement;
    const fileA = new File(["a"], "a.xlsx");
    Object.defineProperty(input, "files", { configurable: true, value: [fileA] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await waitFor(() => expect(exactText("新增 3")).toBeTruthy());

    await click(importConfirmButton());
    await waitFor(() => expect(api.confirmImport).toHaveBeenCalledTimes(1));

    expect(input.disabled).toBe(true);
    expect(host.querySelector(".knowledge-file-button")?.getAttribute("aria-disabled")).toBe("true");
    expect(namedControl("知识库名称").disabled).toBe(true);
    expect(namedControl("一级原因 结果列").disabled).toBe(true);
    expect(namedControl("一级原因 父列约束").disabled).toBe(true);
    expect(namedButton("取消").disabled).toBe(true);
    expect(importConfirmButton().disabled).toBe(true);

    await click(namedButton("×"));
    expect(onClose).not.toHaveBeenCalled();

    const fileB = new File(["b"], "b.xlsx");
    Object.defineProperty(input, "files", { configurable: true, value: [fileB] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await click(importConfirmButton());
    expect(api.previewImport).toHaveBeenCalledTimes(1);
    expect(api.confirmImport).toHaveBeenCalledTimes(1);

    await act(async () => confirmation.resolve(result));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(onImported).toHaveBeenCalledWith(result);
  });

  it("edits and saves values generated from the base columns", async () => {
    const api = createApi();
    await renderUi(<KnowledgeWorkspace section={section} onBack={vi.fn()} apiClient={api} />);
    await waitFor(() => expect(exactText("内容管理")).toBeTruthy());

    await click(namedButton("知识条目"));
    await waitFor(() => expect(namedButton("编辑知识条目")).toBeTruthy());
    await click(namedButton("编辑知识条目"));
    await change(namedControl("二级原因"), "少件");
    await click(namedButton("保存条目"));

    await waitFor(() => expect(api.updateItem).toHaveBeenCalledWith(
      item.id,
      expect.objectContaining({
        values: expect.objectContaining({ 二级原因: "少件" }),
      }),
    ));
  });

  it("marks disabled items and confirms deletion with the project dialog", async () => {
    const disabledItem = { ...item, id: "item-disabled", isEnabled: false };
    const api = createApi({
      listItems: vi.fn().mockResolvedValue({
        items: [disabledItem],
        total: 1,
        page: 1,
        pageSize: 25,
      }),
    });
    await renderUi(<KnowledgeWorkspace section={section} onBack={vi.fn()} apiClient={api} />);
    await waitFor(() => expect(exactText("内容管理")).toBeTruthy());
    await click(namedButton("知识条目"));
    await waitFor(() => expect(exactText("已停用")).toBeTruthy());

    const row = host.querySelector('[data-testid="knowledge-item-item-disabled"]');
    expect(row?.textContent).toContain("已停用");
    const remove = row?.querySelector<HTMLButtonElement>('button[aria-label="删除知识条目"]');
    expect(remove).toBeTruthy();
    await click(remove!);
    expect(exactText("删除知识条目")).toBeTruthy();
    expect(host.textContent).toContain("删除后无法恢复");
  });

  it("renders ranked candidates from local retrieval", async () => {
    const candidates: KnowledgeCandidate[] = [
      { itemId: "one", values: { 一级原因: "商品问题", 二级原因: "破损" }, score: 12.5, matchedText: "外包装破损" },
      { itemId: "two", values: { 一级原因: "物流问题", 二级原因: "挤压" }, score: 8.2, matchedText: "运输挤压" },
    ];
    const api = createApi({ search: vi.fn().mockResolvedValue(candidates) });
    await renderUi(<KnowledgeWorkspace section={section} onBack={vi.fn()} apiClient={api} />);
    await waitFor(() => expect(exactText("内容管理")).toBeTruthy());

    await click(namedButton("检索测试"));
    await change(namedControl("检索测试输入"), "收到商品时外包装已经破损");
    await click(namedButton("开始检索"));

    await waitFor(() => expect(host.querySelectorAll('[data-testid="knowledge-candidate"]')).toHaveLength(2));
    const results = host.querySelectorAll('[data-testid="knowledge-candidate"]');
    expect(results[0].textContent).toContain("01");
    expect(results[0].textContent).toContain("外包装破损");
    expect(results[0].textContent).toContain("已启用");
    expect(results[1].textContent).toContain("02");
  });

  it("shows only export-enabled fields in ordinary record details", async () => {
    const fields: AnalysisField[] = [
      {
        id: "visible", sectionId: section.id, key: "finalReason", label: "最终原因",
        type: "string", prompt: "", required: false, imageEnabled: false, dependsOn: [],
        sortOrder: 1, isEnabled: true, exportEnabled: true,
      },
      {
        id: "internal", sectionId: section.id, key: "matchSnapshot", label: "内部匹配快照",
        type: "string", prompt: "", required: false, imageEnabled: false, dependsOn: [],
        sortOrder: 0, isEnabled: true, exportEnabled: false,
      },
    ];
    const record: RecordDetail = {
      id: "record-1", jobId: "job-1", rowNumber: 2, sheetName: "Sheet1",
      sourceFields: {}, imageUrl: "/api/records/record-1/image", imagePath: "image.png",
      status: "completed", reviewStatus: "pending", humanResult: null, reviewNote: "",
      conversationId: "TEST20260922ABC123", conversationIdAssignedAt: "2026-09-22T09:00:00.000Z",
      analysisRuns: [],
      fieldRuns: [
        {
          id: "run-internal", recordId: "record-1", fieldId: "internal",
          sectionId: section.id, fieldKey: "matchSnapshot", status: "completed",
          result: { matchSnapshot: "diagnostic-only" }, dependencies: {},
          createdAt: "2026-09-09T09:00:00.000Z",
        },
        {
          id: "run-visible", recordId: "record-1", fieldId: "visible",
          sectionId: section.id, fieldKey: "finalReason", status: "completed",
          result: { finalReason: "商品破损" }, dependencies: {},
          createdAt: "2026-09-09T09:00:00.000Z",
        },
      ],
    };

    const setRecord = vi.fn();
    await renderUi(<Detail
      record={record}
      section={section}
      fields={fields}
      busy={false}
      setRecord={setRecord}
      onAnalyze={vi.fn()}
      onRetry={vi.fn()}
      onSave={vi.fn()}
    />);

    expect((namedControl("最终原因") as HTMLTextAreaElement).value).toBe("商品破损");
    expect(host.textContent).not.toContain("内部匹配快照");
    expect(host.querySelector<HTMLTextAreaElement>('textarea[value="diagnostic-only"]')).toBeNull();

    await change(namedControl("最终原因"), "物流破损");
    expect(setRecord).toHaveBeenCalledWith(expect.objectContaining({
      humanResult: { finalReason: "物流破损" },
    }));
  });

  it("ignores stale item loads after base changes", async () => {
    const first = deferred<KnowledgeItemPage>();
    const second = deferred<KnowledgeItemPage>();
    const baseTwo = { ...base, id: "base-2", name: "物流原因库" };
    const api = createApi({
      listItems: vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    });

    await renderUi(<KnowledgeItemList base={base} apiClient={api} onBaseCountChanged={vi.fn()} />);
    await waitFor(() => expect(api.listItems).toHaveBeenCalledTimes(1));
    await renderUi(<KnowledgeItemList base={baseTwo} apiClient={api} onBaseCountChanged={vi.fn()} />);
    await waitFor(() => expect(api.listItems).toHaveBeenCalledTimes(2));

    await act(async () => second.resolve({
      items: [{ ...item, id: "new-item", knowledgeBaseId: baseTwo.id, values: { ...item.values, 二级原因: "超时" } }],
      total: 1,
      page: 1,
      pageSize: 25,
    }));
    await waitFor(() => expect(host.textContent).toContain("超时"));

    await act(async () => first.resolve({
      items: [{ ...item, id: "old-item", values: { ...item.values, 二级原因: "旧响应" } }],
      total: 1,
      page: 1,
      pageSize: 25,
    }));
    expect(host.textContent).toContain("超时");
    expect(host.textContent).not.toContain("旧响应");
  });

  it("resets search state when the selected base changes", async () => {
    const baseTwo = { ...base, id: "base-2", name: "物流原因库" };
    const api = createApi({
      search: vi.fn().mockResolvedValue([
        { itemId: "one", values: item.values, score: 1, matchedText: "外包装破损" },
      ]),
    });

    await renderUi(<KnowledgeSearchTest base={base} apiClient={api} />);
    await change(namedControl("检索测试输入"), "破损");
    await click(namedButton("开始检索"));
    await waitFor(() => expect(host.querySelectorAll('[data-testid="knowledge-candidate"]')).toHaveLength(1));

    await renderUi(<KnowledgeSearchTest base={baseTwo} apiClient={api} />);
    expect((namedControl("检索测试输入") as HTMLTextAreaElement).value).toBe("");
    expect(host.querySelectorAll('[data-testid="knowledge-candidate"]')).toHaveLength(0);
    expect(host.textContent).not.toContain("没有召回候选");
  });

  it("locks base mutations and reports failures", async () => {
    const update = deferred<KnowledgeBase>();
    const api = createApi({ updateBase: vi.fn().mockReturnValue(update.promise) });
    await renderUi(<KnowledgeBaseList
      sectionId={section.id}
      bases={[base]}
      selectedId={base.id}
      apiClient={api}
      onSelect={vi.fn()}
      onImport={vi.fn()}
      onReimport={vi.fn()}
      onChanged={vi.fn()}
    />);

    await click(namedButton("停用"));
    expect(namedButton("停用").disabled).toBe(true);
    await act(async () => update.reject(new Error("状态更新失败")));
    await waitFor(() => expect(host.textContent).toContain("状态更新失败"));
    expect(namedButton("停用").disabled).toBe(false);
  });

  it("refreshes and reports partial batch mutation failures", async () => {
    const secondItem = { ...item, id: "item-2", values: { ...item.values, 二级原因: "少件" } };
    const api = createApi({
      listItems: vi.fn().mockResolvedValue({
        items: [item, secondItem],
        total: 2,
        page: 1,
        pageSize: 25,
      }),
      updateItem: vi.fn()
        .mockResolvedValueOnce({ ...item, isEnabled: false })
        .mockRejectedValueOnce(new Error("第二条失败")),
    });
    await renderUi(<KnowledgeItemList base={base} apiClient={api} onBaseCountChanged={vi.fn()} />);
    await waitFor(() => expect(host.querySelectorAll("tbody tr")).toHaveLength(2));

    await click(namedControl("选择当前页全部条目"));
    await click(namedButton("批量停用"));

    await waitFor(() => expect(api.listItems).toHaveBeenCalledTimes(2));
    expect(host.textContent).toContain("批量更新部分失败");
    expect(host.textContent).toContain("列表已刷新");
  });

  it("converges pagination after deleting the only item on the last page", async () => {
    let deleted = false;
    const api = createApi({
      listItems: vi.fn(async (_baseId, query) => {
        if (query.page === 3 && !deleted) {
          return { items: [item], total: 51, page: 3, pageSize: 25 };
        }
        if (query.page === 3) {
          return { items: [], total: 50, page: 3, pageSize: 25 };
        }
        return {
          items: [{ ...item, id: `page-${query.page}` }],
          total: deleted ? 50 : 51,
          page: query.page ?? 1,
          pageSize: 25,
        };
      }),
      deleteItem: vi.fn(async () => {
        deleted = true;
        return true;
      }),
    });
    await renderUi(<KnowledgeItemList base={base} apiClient={api} onBaseCountChanged={vi.fn()} />);
    await waitFor(() => expect(exactText("1 / 3")).toBeTruthy());
    await click(namedButton("下一页"));
    await waitFor(() => expect(exactText("2 / 3")).toBeTruthy());
    await click(namedButton("下一页"));
    await waitFor(() => expect(exactText("3 / 3")).toBeTruthy());

    await click(namedButton("删除知识条目"));
    await click(namedButton("确认删除"));

    await waitFor(() => expect(exactText("2 / 2")).toBeTruthy());
    expect(host.textContent).not.toContain("3 / 2");
    expect(vi.mocked(api.listItems).mock.calls.at(-1)?.[1].page).toBe(2);
  });

  it("connects every tab to a stable tabpanel and supports keyboard navigation", async () => {
    const api = createApi();
    await renderUi(<KnowledgeWorkspace section={section} onBack={vi.fn()} apiClient={api} />);
    await waitFor(() => expect(host.querySelector('[role="tablist"]')).toBeTruthy());

    const tablist = host.querySelector('[role="tablist"]');
    const tabs = [...(tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    expect(tabs).toHaveLength(3);
    for (const tab of tabs) {
      const panelId = tab.getAttribute("aria-controls");
      const panel = panelId ? host.querySelector<HTMLElement>(`#${panelId}`) : null;
      expect(panel).toBeTruthy();
      expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
    }

    tabs[0].focus();
    await act(async () => tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[1]);

    await act(async () => tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[2]);

    await act(async () => tabs[2].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[0]);

    await act(async () => tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[2]);
  });

  it("uses fixed mobile sticky dimensions", async () => {
    const api = createApi();
    await renderUi(<KnowledgeWorkspace section={section} onBack={vi.fn()} apiClient={api} />);

    const css = fs.readFileSync("src/client/styles.css", "utf8");
    expect(css).toContain("--knowledge-tabs-row-height:52px");
    expect(css).toContain("--knowledge-selector-height:44px");
    expect(css).toContain("top:calc(var(--knowledge-tabs-row-height) + var(--knowledge-selector-height))");
  });
});
