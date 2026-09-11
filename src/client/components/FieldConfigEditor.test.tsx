// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisField, AnalysisSection, KnowledgeBase, KnowledgeColumn } from "../../shared/types";
import { knowledgeApi } from "../api/knowledge-api";
import { FieldConfigEditor } from "./FieldConfigEditor";
import { SectionConfigDialog } from "./SectionConfigDialog";

const section: AnalysisSection = {
  id: "refund",
  parentId: "after-sales",
  name: "退款售后",
  prompt: "",
  outputSchema: [],
  sourceFields: ["最终原因", "客服备注"],
  sortOrder: 1,
  isEnabled: true,
};

const base: KnowledgeBase = {
  id: "base-1",
  sectionId: section.id,
  name: "退款原因库",
  originalFilename: "refund.xlsx",
  columns: [
    { name: "一级原因", roles: ["result", "search"] },
    { name: "三级原因", roles: ["result"] },
    { name: "说明", roles: ["description"] },
  ],
  itemCount: 3,
  isEnabled: true,
  createdAt: "2026-09-09T08:00:00.000Z",
  updatedAt: "2026-09-09T09:00:00.000Z",
};

function field(patch: Partial<AnalysisField> = {}): AnalysisField {
  return {
    id: "field-1",
    sectionId: section.id,
    key: "reason",
    label: "最终原因",
    type: "string",
    prompt: "判断退款原因",
    required: true,
    imageEnabled: true,
    dependsOn: ["客服备注"],
    sortOrder: 0,
    isEnabled: true,
    options: [],
    outputColumn: "最终原因",
    executionType: "ai",
    exportEnabled: true,
    candidateLimit: 15,
    ...patch,
  };
}

let host: HTMLDivElement;
let root: Root;

async function renderUi(element: ReactElement) {
  await act(async () => {
    root.render(element);
  });
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

function control(name: string) {
  const labelled = host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    `[aria-label="${name}"]`,
  );
  if (labelled) return labelled;
  const label = [...host.querySelectorAll("label")].find((candidate) => (
    candidate.textContent?.trim().startsWith(name)
  ));
  const nested = label?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    "input, textarea, select",
  );
  if (!nested) throw new Error(`Control not found: ${name}\n${host.innerHTML}`);
  return nested;
}

function button(name: string) {
  const target = [...host.querySelectorAll("button")].find((candidate) => (
    candidate.textContent?.trim() === name
    || candidate.textContent?.trim().startsWith(name)
    || candidate.getAttribute("aria-label") === name
  ));
  if (!target) throw new Error(`Button not found: ${name}\n${host.innerHTML}`);
  return target as HTMLButtonElement;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
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

describe("FieldConfigEditor knowledge modes", () => {
  it("shows the existing prompt, image, required, and dependency controls for AI fields", async () => {
    const listBases = vi.spyOn(knowledgeApi, "listBases").mockResolvedValue([base]);
    await renderUi(<FieldConfigEditor
      fields={[field()]}
      sourceFields={section.sourceFields}
      onChange={vi.fn()}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
    />);

    expect(button("AI 解析").getAttribute("aria-pressed")).toBe("true");
    expect(control("字段提示词")).toBeTruthy();
    expect(control("图片解析")).toBeTruthy();
    expect(control("必填")).toBeTruthy();
    expect(button("显示选择")).toBeTruthy();
    expect(listBases).not.toHaveBeenCalled();
  });

  it("shows knowledge base, candidate count, prompt, dependencies, and export toggle for match fields", async () => {
    const listBases = vi.spyOn(knowledgeApi, "listBases").mockResolvedValue([base]);
    await renderUi(<FieldConfigEditor
      fields={[field({
        executionType: "knowledge_match",
        exportEnabled: false,
        knowledgeBaseId: base.id,
        outputColumn: "",
      })]}
      sourceFields={section.sourceFields}
      onChange={vi.fn()}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
    />);

    await waitFor(() => expect(listBases).toHaveBeenCalledWith(section.id));
    expect((control("知识库") as HTMLSelectElement).value).toBe(base.id);
    expect((control("候选数") as HTMLInputElement).value).toBe("15");
    expect(control("字段提示词")).toBeTruthy();
    expect(button("显示选择")).toBeTruthy();
    expect((control("导出到 Excel") as HTMLInputElement).checked).toBe(false);
  });

  it("shows match source, dynamic knowledge column, and target Excel field for extract fields", async () => {
    vi.spyOn(knowledgeApi, "listBases").mockResolvedValue([base]);
    const match = field({
      id: "match-field",
      key: "reasonMatch",
      label: "原因匹配",
      executionType: "knowledge_match",
      knowledgeBaseId: base.id,
      exportEnabled: false,
      outputColumn: "",
    });
    const extract = field({
      id: "extract-field",
      key: "level3",
      label: "三级原因",
      executionType: "knowledge_extract",
      matchFieldKey: match.key,
      knowledgeColumn: "三级原因",
      dependsOn: [match.key],
    });
    await renderUi(<FieldConfigEditor
      fields={[match, extract]}
      sourceFields={section.sourceFields}
      onChange={vi.fn()}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
    />);

    await waitFor(() => expect((control("知识列") as HTMLSelectElement).value).toBe("三级原因"));
    expect((control("匹配来源") as HTMLSelectElement).value).toBe(match.key);
    expect([...((control("知识列") as HTMLSelectElement).options)].map((option) => option.value))
      .toContain("说明");
    expect((control("目标 Excel 字段") as HTMLSelectElement).value).toBe("最终原因");
    const extractEditor = host.querySelectorAll(".field-editor")[1];
    expect(extractEditor.querySelector('[aria-label="字段提示词"]')).toBeNull();
    expect(extractEditor.querySelector('[aria-label="图片解析"]')).toBeNull();
  });

  it("saves an internal match field without an output column and preserves the complete payload", async () => {
    const internalMatch = field({
      executionType: "knowledge_match",
      exportEnabled: false,
      knowledgeBaseId: base.id,
      candidateLimit: 8,
      outputColumn: "",
      matchFieldKey: "remembered-match",
      knowledgeColumn: "remembered-column",
    });
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ url, method, body });
      const data = url.endsWith("/fields") && method === "GET"
        ? [internalMatch]
        : url.endsWith("/knowledge-bases")
          ? [base]
          : body ?? {};
      return {
        ok: true,
        json: async () => ({ success: true, data }),
      };
    }));

    await renderUi(<SectionConfigDialog
      sections={[
        { ...section, id: "after-sales", parentId: null, name: "售后分析" },
        section,
      ]}
      close={vi.fn()}
      saved={vi.fn()}
    />);
    await waitFor(() => expect(button("保存字段配置 →")).toBeTruthy());
    await click(button("保存字段配置 →"));
    await waitFor(() => expect(requests.some((request) => (
      request.url === `/api/fields/${internalMatch.id}` && request.method === "PATCH"
    ))).toBe(true));

    const savedField = requests.find((request) => (
      request.url === `/api/fields/${internalMatch.id}` && request.method === "PATCH"
    ))?.body;
    expect(savedField).toMatchObject({
      sectionId: section.id,
      outputColumn: "",
      executionType: "knowledge_match",
      exportEnabled: false,
      knowledgeBaseId: base.id,
      candidateLimit: 8,
      matchFieldKey: "remembered-match",
      knowledgeColumn: "remembered-column",
    });
  });

  it("synchronizes execution settings when a field changes mode", async () => {
    let current = field({ outputColumn: "客服备注", exportEnabled: true });
    const onChange = vi.fn((_index: number, patch: Partial<AnalysisField>) => {
      current = { ...current, ...patch };
    });
    await renderUi(<FieldConfigEditor
      fields={[current]}
      sourceFields={section.sourceFields}
      onChange={onChange}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
    />);

    await click(button("知识库匹配"));
    expect(onChange).toHaveBeenLastCalledWith(0, {
      executionType: "knowledge_match",
      exportEnabled: false,
      outputColumn: "",
    });

    current = { ...current, executionType: "knowledge_match", exportEnabled: false, outputColumn: "" };
    await renderUi(<FieldConfigEditor fields={[current]} sourceFields={section.sourceFields} onChange={onChange} onAdd={vi.fn()} onRemove={vi.fn()} />);
    await click(button("知识结果提取"));
    expect(onChange).toHaveBeenLastCalledWith(0, {
      executionType: "knowledge_extract",
      exportEnabled: false,
    });

    current = { ...current, executionType: "knowledge_extract", exportEnabled: false, outputColumn: "客服备注" };
    await renderUi(<FieldConfigEditor fields={[current]} sourceFields={section.sourceFields} onChange={onChange} onAdd={vi.fn()} onRemove={vi.fn()} />);
    await click(button("AI 解析"));
    expect(onChange).toHaveBeenLastCalledWith(0, {
      executionType: "ai",
      exportEnabled: true,
    });
  });

  it("clears an invalid knowledge column and reports a save-blocking configuration error", async () => {
    const baseTwo = { ...base, id: "base-2", name: "新原因库", columns: [{ name: "新列", roles: ["result"] }] satisfies KnowledgeColumn[] };
    vi.spyOn(knowledgeApi, "listBases").mockResolvedValue([base, baseTwo]);
    const matchOne = field({ id: "match-one", key: "matchOne", executionType: "knowledge_match", knowledgeBaseId: base.id, exportEnabled: false, outputColumn: "" });
    const matchTwo = field({ id: "match-two", key: "matchTwo", executionType: "knowledge_match", knowledgeBaseId: baseTwo.id, exportEnabled: false, outputColumn: "" });
    const extract = field({ id: "extract", key: "extract", executionType: "knowledge_extract", matchFieldKey: matchOne.key, knowledgeColumn: "一级原因", outputColumn: "最终原因" });
    const onChange = vi.fn();
    const onValidationChange = vi.fn();
    await renderUi(<FieldConfigEditor
      fields={[matchOne, matchTwo, extract]}
      sourceFields={section.sourceFields}
      onChange={onChange}
      onValidationChange={onValidationChange}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
    />);

    await change(control("匹配来源"), matchTwo.key);
    expect(onChange).toHaveBeenCalledWith(2, { matchFieldKey: matchTwo.key, knowledgeColumn: undefined });
    await waitFor(() => expect(host.textContent).toContain("当前匹配来源不包含原知识列，请重新选择"));
    expect(onValidationChange).toHaveBeenCalledWith("extract", expect.stringContaining("当前匹配来源不包含原知识列"));
  });

  it("lets the user choose a replacement knowledge column after clearing an invalid one", async () => {
    const baseTwo = { ...base, id: "base-2", name: "新原因库", columns: [{ name: "新列", roles: ["result"] }] satisfies KnowledgeColumn[] };
    vi.spyOn(knowledgeApi, "listBases").mockResolvedValue([base, baseTwo]);
    const matchOne = field({ id: "match-one", key: "matchOne", executionType: "knowledge_match", knowledgeBaseId: base.id, exportEnabled: false, outputColumn: "" });
    const matchTwo = field({ id: "match-two", key: "matchTwo", executionType: "knowledge_match", knowledgeBaseId: baseTwo.id, exportEnabled: false, outputColumn: "" });
    let currentFields = [
      matchOne,
      matchTwo,
      field({ id: "extract", key: "extract", executionType: "knowledge_extract", matchFieldKey: matchOne.key, knowledgeColumn: "一级原因", outputColumn: "最终原因" }),
    ];
    const onChange = vi.fn((index: number, patch: Partial<AnalysisField>) => {
      currentFields = currentFields.map((current, fieldIndex) => fieldIndex === index ? { ...current, ...patch } : current);
    });
    const onValidationChange = vi.fn();
    await renderUi(<FieldConfigEditor fields={currentFields} sourceFields={section.sourceFields} onChange={onChange} onValidationChange={onValidationChange} onAdd={vi.fn()} onRemove={vi.fn()} />);
    await change(control("匹配来源"), matchTwo.key);
    currentFields = currentFields.map((current) => current.id === "extract" ? { ...current, matchFieldKey: matchTwo.key, knowledgeColumn: undefined } : current);
    await renderUi(<FieldConfigEditor fields={currentFields} sourceFields={section.sourceFields} onChange={onChange} onValidationChange={onValidationChange} onAdd={vi.fn()} onRemove={vi.fn()} />);
    const knowledgeColumn = control("知识列") as HTMLSelectElement;
    expect(knowledgeColumn.disabled).toBe(false);
    await change(knowledgeColumn, "新列");
    currentFields = currentFields.map((current) => current.id === "extract" ? { ...current, knowledgeColumn: "新列" } : current);
    await renderUi(<FieldConfigEditor fields={currentFields} sourceFields={section.sourceFields} onChange={onChange} onValidationChange={onValidationChange} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(host.textContent).not.toContain("当前匹配来源不包含原知识列，请重新选择");
    expect(onValidationChange).toHaveBeenLastCalledWith("extract", "");
  });

  it("shows knowledge loading state and clears stale bases before a new load", async () => {
    const first = { promise: Promise.resolve([base]), resolve: (_value: KnowledgeBase[]) => undefined };
    let resolveSecond!: (value: KnowledgeBase[]) => void;
    const second = new Promise<KnowledgeBase[]>((resolve) => { resolveSecond = resolve; });
    const listBases = vi.spyOn(knowledgeApi, "listBases")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second);
    const match = field({ executionType: "knowledge_match", knowledgeBaseId: base.id, exportEnabled: false, outputColumn: "" });
    await renderUi(<FieldConfigEditor fields={[match]} sourceFields={section.sourceFields} onChange={vi.fn()} onAdd={vi.fn()} onRemove={vi.fn()} />);
    await waitFor(() => expect((control("知识库") as HTMLSelectElement).value).toBe(base.id));
    await renderUi(<FieldConfigEditor fields={[{ ...match, sectionId: "other-section" }]} sourceFields={section.sourceFields} onChange={vi.fn()} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(host.textContent).toContain("正在加载知识库");
    expect((control("知识库") as HTMLSelectElement).querySelector('option[value="base-1"]')).toBeNull();
    resolveSecond([]);
    await waitFor(() => expect(host.textContent).not.toContain("正在加载知识库"));
    expect(listBases).toHaveBeenCalledTimes(2);
  });

  it("aborts stale section field requests and keeps the current section loading until its response", async () => {
    let resolveFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    let resolveSecond!: (response: Response) => void;
    const second = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    const requests: Array<{ url: string; signal?: AbortSignal }> = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, signal: init?.signal as AbortSignal | undefined });
      if (init?.signal) init.signal.addEventListener("abort", () => resolveFirst({
        ok: false,
        json: async () => ({ success: false, error: "aborted" }),
      } as Response), { once: true });
      return url.includes("/refund/") ? first : second;
    }));
    await renderUi(<SectionConfigDialog
      sections={[
        { ...section, id: "after-sales", parentId: null, name: "售后分析" },
        section,
        { ...section, id: "logistics", name: "物流售后" },
      ]}
      close={vi.fn()}
      saved={vi.fn()}
    />);
    await waitFor(() => expect(requests).toHaveLength(1));
    await click(button("物流售后"));
    expect(requests[0].signal?.aborted).toBe(true);
    expect(host.textContent).toContain("正在加载字段...");
    resolveSecond({
      ok: true,
      json: async () => ({ success: true, data: [field({ sectionId: "logistics", id: "logistics-field", label: "物流字段" })] }),
    } as Response);
    await waitFor(() => expect(host.textContent).toContain("物流字段"));
    expect(host.textContent).not.toContain("旧板块字段");
    resolveFirst({
      ok: true,
      json: async () => ({ success: true, data: [field({ id: "stale-field", label: "旧板块字段" })] }),
    } as Response);
  });

  it("clears field errors when switching sections", async () => {
    const baseTwo = { ...base, id: "base-2", name: "新原因库", columns: [{ name: "新列", roles: ["result"] }] satisfies KnowledgeColumn[] };
    vi.spyOn(knowledgeApi, "listBases").mockResolvedValue([base, baseTwo]);
    const matchOne = field({ id: "match-one", key: "matchOne", executionType: "knowledge_match", knowledgeBaseId: base.id, exportEnabled: false, outputColumn: "" });
    const matchTwo = field({ id: "match-two", key: "matchTwo", executionType: "knowledge_match", knowledgeBaseId: baseTwo.id, exportEnabled: false, outputColumn: "" });
    const extract = field({ id: "extract", key: "extract", executionType: "knowledge_extract", matchFieldKey: matchOne.key, knowledgeColumn: "一级原因", outputColumn: "最终原因" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/fields") && url.includes("/refund/")) return { ok: true, json: async () => ({ success: true, data: [matchOne, matchTwo, extract] }) };
      if (url.endsWith("/fields")) return { ok: true, json: async () => ({ success: true, data: [] }) };
      return { ok: true, json: async () => ({ success: true, data: init?.body ? JSON.parse(String(init.body)) : {} }) };
    }));
    await renderUi(<SectionConfigDialog sections={[
      { ...section, id: "after-sales", parentId: null, name: "售后分析" },
      section,
      { ...section, id: "logistics", name: "物流售后" },
    ]} close={vi.fn()} saved={vi.fn()} />);
    await waitFor(() => expect((control("匹配来源") as HTMLSelectElement).value).toBe(matchOne.key));
    await change(control("匹配来源"), matchTwo.key);
    await waitFor(() => expect(host.querySelector(".form-error")?.textContent).toContain("当前匹配来源不包含原知识列"));
    await click(button("物流售后"));
    await waitFor(() => expect(button("保存字段配置 →").disabled).toBe(false));
  });

  it("clears an extract field error when switching that field to AI", async () => {
    const baseTwo = { ...base, id: "base-2", name: "新原因库", columns: [{ name: "新列", roles: ["result"] }] satisfies KnowledgeColumn[] };
    vi.spyOn(knowledgeApi, "listBases").mockResolvedValue([base, baseTwo]);
    const matchOne = field({ id: "match-one", key: "matchOne", executionType: "knowledge_match", knowledgeBaseId: base.id, exportEnabled: false, outputColumn: "" });
    const matchTwo = field({ id: "match-two", key: "matchTwo", executionType: "knowledge_match", knowledgeBaseId: baseTwo.id, exportEnabled: false, outputColumn: "" });
    const extract = field({ id: "extract", key: "extract", executionType: "knowledge_extract", matchFieldKey: matchOne.key, knowledgeColumn: "一级原因", outputColumn: "最终原因" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/fields")) return { ok: true, json: async () => ({ success: true, data: [matchOne, matchTwo, extract] }) };
      return { ok: true, json: async () => ({ success: true, data: init?.body ? JSON.parse(String(init.body)) : {} }) };
    }));
    await renderUi(<SectionConfigDialog sections={[
      { ...section, id: "after-sales", parentId: null, name: "售后分析" },
      section,
    ]} close={vi.fn()} saved={vi.fn()} />);
    await waitFor(() => expect((control("匹配来源") as HTMLSelectElement).value).toBe(matchOne.key));
    await change(control("匹配来源"), matchTwo.key);
    await waitFor(() => expect(button("保存字段配置 →").disabled).toBe(true));
    const extractEditor = host.querySelectorAll(".field-editor")[2];
    await click([...extractEditor.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "AI 解析")!);
    await waitFor(() => expect(button("保存字段配置 →").disabled).toBe(false));
  });
});
