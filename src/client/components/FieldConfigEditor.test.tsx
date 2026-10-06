// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisField, AnalysisSection, KnowledgeBase, KnowledgeColumn, SectionConfigVersion } from "../../shared/types";
import { knowledgeApi } from "../api/knowledge-api";
import { FieldConfigEditor } from "./FieldConfigEditor";
import { SectionConfigDialog } from "./SectionConfigDialog";
import { HOT_TOPIC_PROMPT } from "../../shared/hot-topic";

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

type TestControl = HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement;

function control(name: string): TestControl {
  const labelled = host.querySelector<TestControl>(
    `[aria-label="${name}"]`,
  );
  if (labelled) return labelled;
  const label = [...host.querySelectorAll("label")].find((candidate) => (
    candidate.textContent?.trim().startsWith(name)
  ));
  const nested = label?.querySelector<TestControl>(
    'input, textarea, button[aria-haspopup="listbox"]',
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

async function change(element: TestControl, value: string) {
  if (element instanceof HTMLButtonElement) {
    await click(element);
    const option = host.querySelector<HTMLButtonElement>(`[role="option"][data-value="${value}"]`);
    if (!option) throw new Error(`Option not found: ${value}\n${host.innerHTML}`);
    await click(option);
    return;
  }
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement
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
  it("configures capture only for the hot-topic AI field and applies the prompt explicitly", async () => {
    const onChange = vi.fn();
    const hotField = field({ sectionId: "hot-topic", key: "高频问题", label: "高频问题", knowledgeSyncEnabled: true });
    await renderUi(<FieldConfigEditor fields={[hotField]} sourceFields={["高频问题"]} onChange={onChange} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect((control("启用高频问题知识沉淀") as HTMLInputElement).checked).toBe(true);
    expect(control("每条记录最多提炼问题数").value).toBe("2");
    await click(button("使用问题提炼提示词"));
    expect(onChange).toHaveBeenCalledWith(0, expect.objectContaining({ prompt: HOT_TOPIC_PROMPT, type: "string", imageEnabled: false, required: false }));
    await click(control("启用高频问题知识沉淀"));
    expect(onChange).toHaveBeenCalledWith(0, { knowledgeSyncEnabled: false });
    await renderUi(<FieldConfigEditor fields={[{ ...hotField, sectionId: "refund" }]} onChange={onChange} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(host.querySelector('[aria-label="启用高频问题知识沉淀"]')).toBeNull();
  });
  it("configures standard-reason capture on the lost-deal attribution field", async () => {
    const onChange = vi.fn();
    const attribution = field({
      sectionId: "lost-deal",
      key: "未成交归因",
      label: "未成交归因",
      type: "object",
      executionType: "lost_deal_attribution",
      knowledgeSyncEnabled: true,
    });
    await renderUi(<FieldConfigEditor fields={[attribution]} onChange={onChange} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(host.textContent).toContain("未成交原因知识沉淀");
    expect((control("启用未成交原因知识沉淀") as HTMLInputElement).checked).toBe(true);
    await click(control("启用未成交原因知识沉淀"));
    expect(onChange).toHaveBeenCalledWith(0, { knowledgeSyncEnabled: false });
  });
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

  it("keeps the stable field key when the export header changes", async () => {
    const onChange = vi.fn();
    await renderUi(<FieldConfigEditor
      fields={[field({ key: "stable_reason", outputColumn: "最终原因" })]}
      sourceFields={section.sourceFields}
      onChange={onChange}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
    />);

    await change(control("目标 Excel 字段"), "客服备注");

    expect(onChange).toHaveBeenCalledWith(0, { outputColumn: "客服备注" });
  });

  it("allows an ordinary field to select its configured input sources", async () => {
    const onChange = vi.fn();
    await renderUi(<FieldConfigEditor
      fields={[field()]}
      sourceFields={["平台", "店铺"]}
      allowInputSources
      onChange={onChange}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
    />);

    await change(control("字段输入来源"), "平台");

    expect(onChange).toHaveBeenCalledWith(0, { inputSources: ["平台"] });
  });

  it("allows adding a field after all source columns are already used", async () => {
    const onAdd = vi.fn();
    await renderUi(<FieldConfigEditor
      fields={[field({ outputColumn: "最终原因" }), field({ id: "field-2", key: "note", outputColumn: "客服备注" })]}
      sourceFields={["最终原因", "客服备注"]}
      onChange={vi.fn()}
      onAdd={onAdd}
      onRemove={vi.fn()}
    />);

    await click(button("＋ 新增普通字段"));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("exposes field sorting controls with boundary states", async () => {
    const onMove = vi.fn();
    const first = field({ key: "first", label: "第一字段" });
    const second = field({ id: "field-2", key: "second", label: "第二字段" });
    await renderUi(<FieldConfigEditor
      fields={[first, second]}
      onChange={vi.fn()}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      onMove={onMove}
    />);

    expect(button("上移字段 第一字段").disabled).toBe(true);
    expect(button("下移字段 第一字段").disabled).toBe(false);
    expect(button("上移字段 第二字段").disabled).toBe(false);
    expect(button("下移字段 第二字段").disabled).toBe(true);

    await click(button("下移字段 第一字段"));
    expect(onMove).toHaveBeenCalledWith(0, 1);
    await click(button("上移字段 第二字段"));
    expect(onMove).toHaveBeenCalledWith(1, 0);
  });

  it("edits a draft version snapshot through one version patch", async () => {
    const draft: SectionConfigVersion = {
      id: "version-draft",
      sectionId: section.id,
      versionNumber: 3,
      status: "draft",
      isCurrent: false,
      sectionSnapshot: section,
      fieldsSnapshot: [field({ key: "stable_reason", outputColumn: "最终原因" })],
      exportSettings: {
        rowMode: "records",
        outputColumns: [
          { key: "platform_name", outputColumn: "平台", source: "platform_name", format: "value" },
          { key: "conversation_id", outputColumn: "会话ID", source: "conversation_id", format: "value" },
          { key: "stable_reason", outputColumn: "最终原因", source: "field_result", format: "value" },
        ],
      },
      dependenciesSnapshot: [{ key: "stable_reason", dependsOn: [] }],
      knowledgeSnapshot: [],
      businessRules: {
        kind: "generic",
        importContract: {
          imageColumn: "聊天截图",
          requiredColumns: [],
          optionalColumns: [],
        },
      },
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
    };
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ url, method, body });
      if (url === `/api/sections/${section.id}/versions`) return { ok: true, json: async () => ({ success: true, data: [draft] }) };
      if (url === `/api/section-config-versions/${draft.id}` && method === "PATCH") {
        return { ok: true, json: async () => ({ success: true, data: { ...draft, ...body } }) };
      }
      throw new Error(`未处理请求：${method} ${url}`);
    }));

    await renderUi(<SectionConfigDialog
      sections={[{ ...section, id: "after-sales", parentId: null }, section]}
      close={vi.fn()}
      saved={vi.fn()}
    />);
    await waitFor(() => expect(button("保存草稿配置")).toBeTruthy());
    await click(button("＋ 新增普通字段"));
    await change(control("字段名称"), "更新后的结果");
    await click(button("保存草稿配置"));

    const patches = requests.filter((request) => request.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toBe(`/api/section-config-versions/${draft.id}`);
    expect(patches[0].body).toMatchObject({
      fieldsSnapshot: [expect.objectContaining({
        key: "stable_reason",
        label: "更新后的结果",
        outputColumn: "最终原因",
      }), expect.objectContaining({
        key: "field_2",
        candidateLimit: 15,
        knowledgeSyncEnabled: false,
        knowledgeCaptureLimit: 2,
      })],
    });
  });

  it("shows the current published snapshot when no draft exists", async () => {
    const createPublishedVersion = (
      id: string,
      versionNumber: number,
      isCurrent: boolean,
      label: string,
    ): SectionConfigVersion => ({
      id,
      sectionId: section.id,
      versionNumber,
      status: "published",
      isCurrent,
      sectionSnapshot: { ...section, prompt: `${label}板块说明` },
      fieldsSnapshot: [field({
        key: `${id}-field`,
        label: `${label}字段`,
        prompt: `${label}提示词`,
      })],
      exportSettings: { rowMode: "records", outputColumns: [] },
      dependenciesSnapshot: [],
      knowledgeSnapshot: [],
      businessRules: {
        kind: "generic",
        importContract: {
          imageColumn: "聊天截图",
          requiredColumns: [],
          optionalColumns: [],
        },
      },
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
    });
    const previous = createPublishedVersion("version-8", 8, false, "历史");
    const current = createPublishedVersion("version-9", 9, true, "当前发布");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url === `/api/sections/${section.id}/versions`) {
        return { ok: true, json: async () => ({ success: true, data: [previous, current] }) };
      }
      throw new Error(`未处理请求：${init?.method ?? "GET"} ${url}`);
    }));

    await renderUi(<SectionConfigDialog
      sections={[{ ...section, id: "after-sales", parentId: null }, section]}
      close={vi.fn()}
      saved={vi.fn()}
    />);

    await waitFor(() => {
      expect(button("基于当前版本创建草稿").disabled).toBe(false);
      expect(host.textContent).toContain("V9");
      expect(host.textContent).toContain("当前发布字段");
      expect(host.textContent).toContain("当前发布提示词");
    });
    expect(host.textContent).toContain("当前发布板块说明");
    expect(host.textContent).not.toContain("历史字段");
    expect(host.textContent).not.toContain("创建中...");
    expect(requests).toEqual([`GET /api/sections/${section.id}/versions`]);
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
    expect((control("知识库") as HTMLButtonElement).value).toBe(base.id);
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

    await waitFor(() => expect((control("知识列") as HTMLButtonElement).value).toBe("三级原因"));
    expect((control("匹配来源") as HTMLButtonElement).value).toBe(match.key);
    await click(control("知识列"));
    expect([...host.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.dataset.value))
      .toContain("说明");
    await click(control("知识列"));
    expect((control("目标 Excel 字段") as HTMLButtonElement).value).toBe("最终原因");
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
    const knowledgeColumn = control("知识列") as HTMLButtonElement;
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
    await waitFor(() => expect((control("知识库") as HTMLButtonElement).value).toBe(base.id));
    await renderUi(<FieldConfigEditor fields={[{ ...match, sectionId: "other-section" }]} sourceFields={section.sourceFields} onChange={vi.fn()} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(host.textContent).toContain("正在加载知识库");
    await click(control("知识库"));
    expect(host.querySelector('[role="option"][data-value="base-1"]')).toBeNull();
    await click(control("知识库"));
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
    await waitFor(() => expect((control("匹配来源") as HTMLButtonElement).value).toBe(matchOne.key));
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
    await waitFor(() => expect((control("匹配来源") as HTMLButtonElement).value).toBe(matchOne.key));
    await change(control("匹配来源"), matchTwo.key);
    await waitFor(() => expect(button("保存字段配置 →").disabled).toBe(true));
    const extractEditor = host.querySelectorAll(".field-editor")[2];
    await click([...extractEditor.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "AI 解析")!);
    await waitFor(() => expect(button("保存字段配置 →").disabled).toBe(false));
  });
});
