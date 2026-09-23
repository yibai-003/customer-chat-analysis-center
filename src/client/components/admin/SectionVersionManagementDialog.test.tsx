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
});
