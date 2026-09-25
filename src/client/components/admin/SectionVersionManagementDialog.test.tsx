// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisSection, SectionConfigVersion } from "../../../shared/types";
import { SectionVersionManagementDialog } from "./SectionVersionManagementDialog";

let host: HTMLDivElement;
let root: Root;
let requests: Array<{ url: string; init?: RequestInit }>;

const section: AnalysisSection = {
  id: "reception",
  parentId: "quality",
  name: "接待流程质检",
  prompt: "",
  outputSchema: [],
  sortOrder: 1,
  isEnabled: true,
};

function version(
  id: string,
  versionNumber: number,
  status: SectionConfigVersion["status"],
  isCurrent = false,
): SectionConfigVersion {
  return {
    id,
    sectionId: section.id,
    versionNumber,
    status,
    isCurrent,
    sectionSnapshot: section,
    fieldsSnapshot: [],
    exportSettings: { outputColumns: [] },
    dependenciesSnapshot: [],
    knowledgeSnapshot: [],
    businessRules: {},
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
  };
}

function jsonResponse(data: unknown) {
  return { ok: true, json: async () => ({ success: true, data }) } as Response;
}

async function waitFor(assertion: () => void, timeout = 2000) {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeout) {
    try { assertion(); return; } catch (error) {
      lastError = error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
  }
  throw lastError;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  requests = [];
  let versions = [
    version("draft-3", 3, "draft"),
    version("published-2", 2, "published", true),
    version("archived-1", 1, "archived"),
  ];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === "/api/sections/reception/versions" && (init?.method ?? "GET") === "GET") return jsonResponse(versions);
    if (url === "/api/section-config-versions/draft-3" && (init?.method ?? "GET") === "GET") {
      return jsonResponse({
        ...versions[0],
        businessRules: {
          kind: "reception_quality",
          issues: [{
            id: "PRE_ANSWER_IRRELEVANT",
            name: "答非所问",
            dimension: "需求理解",
            scope: "preSale",
            criterion: "未围绕客户问题作答",
            deduction: 5,
            forceD: false,
            violationCount: 1,
            priority: 10,
            suggestion: "建议围绕客户问题作答",
            applicableWhen: ["存在客户明确问题"],
            triggerWhen: ["回答与问题无关"],
            exclusions: [],
            requiredEvidence: ["客户问题", "客服回答"],
            missingDataOutcome: "待复核",
          }],
        },
      });
    }
    if (url === "/api/section-config-versions/draft-3" && init?.method === "PATCH") {
      return jsonResponse({
        ...versions[0],
        businessRules: JSON.parse(String(init.body)).businessRules,
      });
    }
    if (url === "/api/section-config-versions/archived-1/restore" && init?.method === "POST") {
      versions = versions.map((item) => item.id === "archived-1" ? { ...item, status: "published" as const } : item);
      return jsonResponse(versions[2]);
    }
    if (url === "/api/section-config-versions/draft-3/publish" && init?.method === "POST") {
      versions = versions.map((item) => item.id === "draft-3"
        ? { ...item, status: "published" as const, isCurrent: true }
        : { ...item, isCurrent: false });
      return jsonResponse(versions[0]);
    }
    throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent === text);
}

describe("SectionVersionManagementDialog", () => {
  it("restores archived versions and publishes drafts through lifecycle APIs", async () => {
    const saved = vi.fn();
    await act(async () => root.render(<SectionVersionManagementDialog sections={[section]} close={vi.fn()} saved={saved} />));
    await waitFor(() => expect(host.textContent).toContain("V3"));

    await act(async () => button("恢复")!.click());
    await waitFor(() => expect(host.textContent).toContain("V1 已恢复为已发布版本"));
    expect(requests.some((request) => request.url.endsWith("/archived-1/restore"))).toBe(true);

    await act(async () => button("发布")!.click());
    await waitFor(() => expect(host.textContent).toContain("V3 已发布并启用"));
    expect(requests.some((request) => request.url.endsWith("/draft-3/publish"))).toBe(true);
    expect(saved).toHaveBeenCalledTimes(2);
  });

  it("loads the versioned reception rule catalog for frontend viewing", async () => {
    await act(async () => root.render(<SectionVersionManagementDialog sections={[section]} close={vi.fn()} saved={vi.fn()} />));
    await waitFor(() => expect(host.textContent).toContain("V3"));

    await act(async () => button("查看规则")!.click());
    await waitFor(() => expect(host.textContent).toContain("PRE_ANSWER_IRRELEVANT"));
    expect(host.textContent).toContain("需求理解");
    expect(host.textContent).toContain("5");
    expect(requests.some((request) => request.url.endsWith("/draft-3"))).toBe(true);
  });

  it("saves edited rules only for a draft version", async () => {
    await act(async () => root.render(<SectionVersionManagementDialog sections={[section]} close={vi.fn()} saved={vi.fn()} />));
    await waitFor(() => expect(host.textContent).toContain("V3"));

    await act(async () => button("查看规则")!.click());
    await waitFor(() => expect(host.textContent).toContain("PRE_ANSWER_IRRELEVANT"));
    await act(async () => button("编辑草稿规则")!.click());

    const dimension = host.querySelector<HTMLInputElement>('input[aria-label="规则 PRE_ANSWER_IRRELEVANT 维度"]')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(dimension, "客户需求理解");
      dimension.dispatchEvent(new Event("input", { bubbles: true }));
      dimension.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("保存规则")!.click());
    await waitFor(() => expect(host.textContent).toContain("规则已保存"));
    expect(host.textContent).toContain("客户需求理解");

    const patch = requests.find((request) => request.url.endsWith("/draft-3") && request.init?.method === "PATCH");
    expect(patch).toBeTruthy();
    expect(JSON.parse(String(patch?.init?.body)).businessRules.issues[0].dimension).toBe("客户需求理解");
  });
});
