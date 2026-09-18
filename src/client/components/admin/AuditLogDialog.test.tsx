// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLogDialog } from "./AuditLogDialog";
import type { AuditEvent, AuditEventPage } from "../../../shared/types";

const exported: AuditEvent = {
  id: "e1",
  actorUserId: "u1",
  actorDisplay: "管理员",
  action: "task.export",
  targetType: "job",
  targetId: "job-1",
  outcome: "success",
  metadata: { sections: ["refund"] },
  correlationId: "trace-1",
  occurredAt: "2026-09-17T10:00:00.000Z",
};
const denied: AuditEvent = {
  ...exported,
  id: "e2",
  actorDisplay: "操作人员",
  action: "review.save",
  targetType: "record",
  targetId: "r-1",
  outcome: "failure",
  metadata: { capability: "review:save" },
  correlationId: "trace-2",
  occurredAt: "2026-09-17T09:00:00.000Z",
};

let host: HTMLDivElement;
let root: Root;
let rootMounted = false;
let requests: string[];
let handler: (url: string) => Response;

function jsonResponse(data: unknown) {
  return { ok: true, json: async () => ({ success: true, data }) } as Response;
}

function failureResponse(status: number, error: string) {
  return { ok: false, status, json: async () => ({ success: false, data: null, error }) } as Response;
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

function labeled<T extends HTMLElement>(label: string) {
  return host.querySelector<T>(`[aria-label="${label}"]`);
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

function buttonByText(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  rootMounted = true;
  requests = [];
  handler = () => jsonResponse({ items: [exported, denied], limit: 25, nextCursor: null } satisfies AuditEventPage);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    return handler(url);
  }));
});

afterEach(async () => {
  if (rootMounted) await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderDialog() {
  await act(async () => root.render(<AuditLogDialog close={vi.fn()} />));
  await waitFor(() => expect(host.querySelector(".audit-event")).not.toBeNull());
}

describe("audit log dialog", () => {
  it("renders actor, action, outcome, correlation id and safe metadata", async () => {
    await renderDialog();

    expect(host.textContent).toContain("管理员");
    expect(host.textContent).toContain("task.export");
    expect(host.textContent).toContain("成功");
    expect(host.textContent).toContain("拒绝/失败");
    expect(host.textContent).toContain("trace-1");
    expect(host.textContent).toContain("目标：job / job-1");
    expect(host.textContent).toContain("refund");
    expect(host.querySelectorAll(".audit-event")).toHaveLength(2);
    expect(host.innerHTML).not.toContain("password_hash");
    expect(host.innerHTML).not.toContain("cc_sid");
  });

  it("applies action, outcome and time filters and replaces the list", async () => {
    await renderDialog();
    handler = () => jsonResponse({ items: [denied], limit: 25, nextCursor: null } satisfies AuditEventPage);

    await act(async () => setValue(labeled<HTMLInputElement>("按动作筛选")!, "review.save"));
    await act(async () => setValue(labeled<HTMLSelectElement>("按结果筛选")!, "failure"));
    await act(async () => setValue(labeled<HTMLInputElement>("开始时间")!, "2026-09-17T00:00"));
    await act(async () => buttonByText("查询")!.click());

    await waitFor(() => expect(host.querySelectorAll(".audit-event")).toHaveLength(1));
    const query = new URL(requests.at(-1)!, "http://localhost").searchParams;
    expect(query.get("action")).toBe("review.save");
    expect(query.get("outcome")).toBe("failure");
    expect(query.get("limit")).toBe("25");
    expect(query.get("from")).toBe(new Date("2026-09-17T00:00").toISOString());
    expect(host.textContent).toContain("review.save");
    expect(host.textContent).not.toContain("task.export");
  });

  it("loads older events with the server cursor and appends them", async () => {
    const older: AuditEvent = { ...exported, id: "e3", action: "task.import", correlationId: "trace-3", occurredAt: "2026-09-16T08:00:00.000Z" };
    handler = (url) => url.includes("cursor=cursor-1")
      ? jsonResponse({ items: [older], limit: 25, nextCursor: null } satisfies AuditEventPage)
      : jsonResponse({ items: [exported, denied], limit: 25, nextCursor: "cursor-1" } satisfies AuditEventPage);
    await renderDialog();

    const more = buttonByText("加载更多（更早事件）")!;
    expect(more.disabled).toBe(false);
    await act(async () => more.click());

    await waitFor(() => expect(host.querySelectorAll(".audit-event")).toHaveLength(3));
    expect(requests.at(-1)).toContain("cursor=cursor-1");
    expect(host.textContent).toContain("task.import");
    await waitFor(() => expect(buttonByText("加载更多（更早事件）")!.disabled).toBe(true));
  });

  it("shows the failure reason and keeps filters when a query fails", async () => {
    await renderDialog();
    handler = () => failureResponse(400, "分页游标无效");

    await act(async () => setValue(labeled<HTMLInputElement>("按动作筛选")!, "task.export"));
    await act(async () => buttonByText("查询")!.click());

    await waitFor(() => expect(host.textContent).toContain("分页游标无效"));
    expect(labeled<HTMLInputElement>("按动作筛选")!.value).toBe("task.export");
    expect(buttonByText("查询")!.disabled).toBe(false);
  });
});