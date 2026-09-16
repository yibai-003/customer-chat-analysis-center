// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelConfig, ModelProvider, ModelUsageEvent } from "../../shared/types";
import { ModelConfigDialog } from "./ModelConfigDialog";

const provider: ModelProvider = {
  id: "provider-1",
  name: "千问百炼",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  maskedApiKey: "********abcd",
  isEnabled: true,
  lastTestedAt: "2026-09-16T02:00:00.000Z",
};

function member(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: "model-vision",
    name: "千问视觉",
    baseUrl: provider.baseUrl,
    maskedApiKey: provider.maskedApiKey,
    model: "qwen3-vl-plus",
    supportsVision: true,
    temperature: 0.2,
    maxTokens: 1500,
    isDefault: false,
    purpose: "vision",
    isPurposeDefault: false,
    isEnabled: true,
    capabilityStatus: { text: true, json: true, vision: true },
    capabilityCheckedAt: "2026-09-16T02:00:00.000Z",
    providerId: provider.id,
    providerName: provider.name,
    poolEnabled: true,
    billingMode: "free",
    qualityTier: "A",
    priority: 10,
    thinkingMode: false,
    memberType: "general",
    quotaTotalTokens: 1_000_000,
    quotaUsedTokens: 200_000,
    quotaExpiresAt: "2026-12-31T15:59:59.000Z",
    quotaSafetyRatio: 0.95,
    consecutiveFailures: 0,
    capabilityEligible: true,
    quotaBlocked: false,
    ...overrides,
  };
}

const members = [
  member(),
  member({
    id: "model-text",
    name: "千问文本",
    model: "qwen-plus",
    purpose: "text",
    supportsVision: false,
    capabilityStatus: { text: true, json: true, vision: false },
  }),
];

const usageEvents: ModelUsageEvent[] = [{
  id: "event-1",
  modelConfigId: "model-text",
  providerId: provider.id,
  purpose: "text",
  eventType: "failure",
  inputTokens: 120,
  outputTokens: 18,
  accountedTokens: 138,
  errorCode: "RATE_LIMIT",
  recordId: "record-7",
  fieldId: "field-3",
  operation: "field_analysis",
  durationMs: 842,
  createdAt: "2026-09-16T03:00:00.000Z",
}];

type RequestRecord = { url: string; init?: RequestInit };
let requests: RequestRecord[];
let responseFor: (url: string, init?: RequestInit) => unknown;

function success(data: unknown) {
  return new Response(JSON.stringify({ success: true, data, error: null }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function defaultData(url: string) {
  if (url === "/api/model-pools") {
    return {
      members,
      summary: {
        total: members.length,
        vision: { total: 1, enabled: 1, verified: 1, blocked: 0 },
        text: { total: 1, enabled: 1, verified: 1, blocked: 0 },
      },
    };
  }
  if (url === "/api/model-providers") return [provider];
  if (url === "/api/model-pool-settings") {
    return { paidDailyTokenLimit: 0, paidMonthlyTokenLimit: 0, capabilityTtlMs: 86_400_000 };
  }
  if (url.startsWith("/api/model-usage-events")) return usageEvents;
  if (url.startsWith("/api/model-pool-members/")) return members[0];
  if (url.startsWith("/api/model-providers/")) return provider;
  throw new Error(`Unhandled request: ${url}`);
}

beforeEach(() => {
  requests = [];
  responseFor = (url) => defaultData(url);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    return success(await responseFor(url, init));
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderDialog(models = members) {
  await act(async () => {
    render(<ModelConfigDialog models={models} close={() => undefined} saved={() => undefined} />);
  });
}

describe("ModelConfigDialog", () => {
  it("opens on the model pool and filters members by purpose", async () => {
    await renderDialog();

    expect(screen.getByRole("tab", { name: "模型池" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("千问视觉")).toBeTruthy();
    expect(screen.queryByText("千问文本")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "文本模型" }));
    expect(await screen.findByText("千问文本")).toBeTruthy();
    expect(screen.queryByText("千问视觉")).toBeNull();
  });

  it("installs presets, reports created count, and verifies every required ID in safe batches", async () => {
    const created = Array.from({ length: 51 }, (_, index) => `new-${index + 1}`);
    const existing = Array.from({ length: 52 }, (_, index) => `existing-${index + 1}`);
    responseFor = (url) => {
      if (url === "/api/model-pools/qianwen-free/install") {
        return {
          created,
          updated: existing,
          needsVerification: [...existing, ...created],
        };
      }
      if (url === "/api/model-pools/qianwen-free/verify") return [];
      return defaultData(url);
    };

    await renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "安装/更新千问免费池" }));
    });

    await waitFor(() => expect(
      requests.filter((request) => request.url === "/api/model-pools/qianwen-free/verify"),
    ).toHaveLength(4));
    expect(screen.getByRole("status").textContent).toContain("新建 51");

    const verificationBodies = requests
      .filter((request) => request.url === "/api/model-pools/qianwen-free/verify")
      .map((request) => JSON.parse(String(request.init?.body)));
    expect(verificationBodies).toEqual([
      { ids: existing.slice(0, 50), enablePassed: false },
      { ids: existing.slice(50), enablePassed: false },
      { ids: created.slice(0, 50), enablePassed: true },
      { ids: created.slice(50), enablePassed: true },
    ]);
    const verifiedIds = verificationBodies.flatMap((body) => body.ids);
    expect(verifiedIds).toHaveLength(103);
    expect(new Set(verifiedIds).size).toBe(103);
  });

  it("never places an existing full API key into the provider password field", async () => {
    await renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "服务商凭证" }));
    expect(await screen.findByText("********abcd")).toBeTruthy();
    expect(document.body.textContent).not.toContain("full-provider-secret");

    fireEvent.click(screen.getByRole("button", { name: "编辑千问百炼" }));
    const keyInput = screen.getByLabelText("API Key") as HTMLInputElement;
    expect(keyInput.type).toBe("password");
    expect(keyInput.value).toBe("");
    expect(keyInput.placeholder).toBe("留空则保留原 Key");
  });

  it("sends all editable routing, quota, and billing fields for a member row", async () => {
    await renderDialog();
    const row = (await screen.findByText("千问视觉")).closest("tr");
    if (!row) throw new Error("model row not found");
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));

    fireEvent.change(within(row).getByLabelText("等级"), { target: { value: "B" } });
    fireEvent.change(within(row).getByLabelText("计费"), { target: { value: "paid" } });
    fireEvent.change(within(row).getByLabelText("已用 Token"), { target: { value: "250000" } });
    fireEvent.change(within(row).getByLabelText("总额 Token"), { target: { value: "1200000" } });
    fireEvent.change(within(row).getByLabelText("到期时间"), { target: { value: "2026-12-30T12:30" } });
    fireEvent.change(within(row).getByLabelText("优先级"), { target: { value: "17" } });
    fireEvent.click(within(row).getByLabelText("启用模型"));
    fireEvent.click(within(row).getByLabelText("加入模型池"));
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "保存" }));
    });

    const patch = requests.find((request) => (
      request.url === "/api/model-pool-members/model-vision" && request.init?.method === "PATCH"
    ));
    expect(JSON.parse(String(patch?.init?.body))).toEqual({
      qualityTier: "B",
      billingMode: "paid",
      quotaUsedTokens: 250000,
      quotaTotalTokens: 1200000,
      quotaExpiresAt: "2026-12-30T04:30:00.000Z",
      priority: 17,
      isEnabled: false,
      poolEnabled: false,
      quotaSafetyRatio: 0.95,
    });
  });

  it("keeps inline editing open and refreshes the parent only when the dirty console closes", async () => {
    const close = vi.fn();
    const saved = vi.fn();
    await act(async () => {
      render(<ModelConfigDialog models={members} close={close} saved={saved} />);
    });
    const row = (await screen.findByText("千问视觉")).closest("tr");
    if (!row) throw new Error("model row not found");
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "保存" }));
    });
    await waitFor(() => expect(requests.some((request) => (
      request.url === "/api/model-pool-members/model-vision"
      && request.init?.method === "PATCH"
    ))).toBe(true));

    expect(saved).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "模型池" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "×" }));
    expect(saved).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("requests usage events with purpose, model, and event filters", async () => {
    await renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "调用状态" }));
    await screen.findByText("RATE_LIMIT");

    fireEvent.change(screen.getByLabelText("用途筛选"), { target: { value: "text" } });
    fireEvent.change(screen.getByLabelText("模型筛选"), { target: { value: "model-text" } });
    fireEvent.change(screen.getByLabelText("事件筛选"), { target: { value: "failure" } });

    await waitFor(() => expect(requests.at(-1)?.url).toBe(
      "/api/model-usage-events?purpose=text&modelConfigId=model-text&eventType=failure&limit=100",
    ));
    expect(screen.getByText("record-7 / field-3")).toBeTruthy();
  });

  it("uses distinct text statuses for paid and unavailable members", async () => {
    const statusMembers = [
      member({ id: "paid", name: "付费备用", billingMode: "paid" }),
      member({ id: "quota", name: "额度耗尽", quotaBlocked: true }),
      member({ id: "cooldown", name: "冷却模型", cooldownUntil: "2026-09-17T00:00:00.000Z" }),
      member({ id: "capability", name: "能力失败", capabilityEligible: false }),
      member({ id: "disabled", name: "禁用模型", isEnabled: false }),
      member({ id: "ready", name: "就绪模型" }),
    ];
    responseFor = (url) => url === "/api/model-pools"
      ? {
          members: statusMembers,
          summary: {
            total: statusMembers.length,
            vision: { total: statusMembers.length, enabled: 5, verified: 5, blocked: 2 },
            text: { total: 0, enabled: 0, verified: 0, blocked: 0 },
          },
        }
      : defaultData(url);
    await renderDialog(statusMembers);

    await screen.findByText("付费可用");
    expect(screen.getByText("额度已耗尽")).toBeTruthy();
    expect(screen.getByText("冷却中")).toBeTruthy();
    expect(screen.getByText("能力验证失败")).toBeTruthy();
    expect(screen.getByText("已禁用")).toBeTruthy();
    expect(screen.getByText("可调用")).toBeTruthy();
  });
});
