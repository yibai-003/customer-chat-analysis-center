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

function failure(error: string, status = 500) {
  return new Response(JSON.stringify({ success: false, data: null, error }), {
    status,
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
    const result = await responseFor(url, init);
    return result instanceof Response ? result : success(result);
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

    fireEvent.click(screen.getByRole("tab", { name: "文本模型" }));
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

  it("marks a successful provider creation dirty before a failed refresh and does not invite a duplicate retry", async () => {
    const close = vi.fn();
    const saved = vi.fn();
    let providerLists = 0;
    let poolLists = 0;
    let settingsLists = 0;
    responseFor = (url, init) => {
      if (url === "/api/model-providers") {
        if (init?.method === "POST") return provider;
        providerLists += 1;
        if (providerLists > 1) return failure("供应商列表刷新失败");
        return [provider];
      }
      if (url === "/api/model-pools") {
        poolLists += 1;
        return defaultData(url);
      }
      if (url === "/api/model-pool-settings") {
        settingsLists += 1;
        return defaultData(url);
      }
      if (url === "/api/model-providers/new-provider") return provider;
      return defaultData(url);
    };
    await act(async () => {
      render(<ModelConfigDialog models={members} close={close} saved={saved} />);
    });
    fireEvent.click(screen.getByRole("tab", { name: "服务商凭证" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新服务商" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://new.example/v1" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "new-secret" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "创建服务商" }));
    });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("已创建"));
    expect(requests.filter((request) => (
      request.url === "/api/model-providers" && request.init?.method === "POST"
    ))).toHaveLength(1);
    expect(poolLists).toBe(2);
    expect(settingsLists).toBe(1);
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "×" }));
    expect(saved).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("refreshes provider test metadata after failure while preserving the test failure message", async () => {
    let providerLists = 0;
    responseFor = (url, init) => {
      if (url === "/api/model-providers") {
        providerLists += 1;
        return providerLists === 1 ? [provider] : [{
          ...provider,
          lastTestedAt: "2026-09-16T05:00:00.000Z",
          lastError: "401 credential rejected",
        }];
      }
      if (url === "/api/model-providers/provider-1/test" && init?.method === "POST") {
        return failure("连接失败：401 credential rejected", 400);
      }
      return defaultData(url);
    };
    await renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "服务商凭证" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "测试" }));
    });

    await waitFor(() => expect(screen.getByText("401 credential rejected")).toBeTruthy());
    expect(screen.getByRole("status").textContent).toBe("连接失败：401 credential rejected");
    expect(providerLists).toBe(2);
  });

  it("supports accessible primary and purpose tab keyboard navigation", async () => {
    await renderDialog();
    const providerTab = screen.getByRole("tab", { name: "服务商凭证" });
    const poolTab = screen.getByRole("tab", { name: "模型池" });
    const usageTab = screen.getByRole("tab", { name: "调用状态" });

    for (const tabElement of [providerTab, poolTab, usageTab]) {
      const panelId = tabElement.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      const panel = document.getElementById(panelId!);
      expect(panel).toBeTruthy();
      expect(panel?.getAttribute("aria-labelledby")).toBe(tabElement.id);
    }
    expect(poolTab.tabIndex).toBe(0);
    expect(providerTab.tabIndex).toBe(-1);
    fireEvent.keyDown(poolTab, { key: "ArrowRight" });
    expect(usageTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(usageTab);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(usageTab.id);
    fireEvent.keyDown(usageTab, { key: "Home" });
    expect(document.activeElement).toBe(providerTab);
    fireEvent.keyDown(providerTab, { key: "End" });
    expect(document.activeElement).toBe(usageTab);

    fireEvent.click(poolTab);
    const visionTab = screen.getByRole("tab", { name: "视觉模型" });
    const textTab = screen.getByRole("tab", { name: "文本模型" });
    expect(visionTab.getAttribute("aria-selected")).toBe("true");
    expect(visionTab.getAttribute("aria-controls")).not.toBe(textTab.getAttribute("aria-controls"));
    for (const tabElement of [visionTab, textTab]) {
      const panelId = tabElement.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      const panel = document.getElementById(panelId!);
      expect(panel).toBeTruthy();
      expect(panel?.getAttribute("aria-labelledby")).toBe(tabElement.id);
    }
    fireEvent.keyDown(visionTab, { key: "ArrowRight" });
    expect(textTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(textTab);
    expect(screen.getByRole("tabpanel", { name: "文本模型" })).toBeTruthy();
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
    vi.setSystemTime(new Date("2026-09-16T03:00:00.000Z"));
    const statusMembers = [
      member({ id: "paid", name: "付费备用", billingMode: "paid" }),
      member({ id: "quota", name: "额度耗尽", quotaBlocked: true }),
      member({ id: "cooldown", name: "冷却模型", cooldownUntil: "2026-09-17T00:00:00.000Z" }),
      member({
        id: "capability",
        name: "能力失败",
        capabilityEligible: false,
        capabilityCheckedAt: "2026-09-16T01:00:00.000Z",
        capabilityStatus: { text: false, json: true, vision: true },
      }),
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
    expect(screen.getAllByText("能力验证失败")).toHaveLength(2);
    expect(screen.getByText("已禁用")).toBeTruthy();
    expect(screen.getByText("可调用")).toBeTruthy();
  });

  it("verifies blocked default members from the pool readiness action", async () => {
    const pendingVision = member({
      id: "pending-default",
      name: "待验证视觉",
      isPurposeDefault: true,
      poolEnabled: false,
      capabilityEligible: false,
      capabilityCheckedAt: undefined,
      capabilityStatus: undefined,
    });
    const readyText = member({
      id: "ready-text-default",
      name: "文本默认",
      model: "qwen-plus",
      purpose: "text",
      supportsVision: false,
      isPurposeDefault: true,
      capabilityStatus: { text: true, json: true, vision: false },
    });
    responseFor = (url) => {
      if (url === "/api/model-pools/qianwen-free/verify") {
        return [{
          id: "pending-default",
          model: "qwen3-vl-plus",
          purpose: "vision",
          passed: true,
          capabilities: { text: true, json: true, vision: true },
          checkedAt: "2026-09-16T04:00:00.000Z",
        }];
      }
      if (url === "/api/model-pools") {
        return {
          members: [pendingVision, readyText],
          summary: {
            total: 2,
            vision: { total: 1, enabled: 0, verified: 0, blocked: 0 },
            text: { total: 1, enabled: 1, verified: 1, blocked: 0 },
          },
        };
      }
      return defaultData(url);
    };
    await renderDialog([pendingVision, readyText]);
    expect(requests.some((request) => request.url === "/api/model-pools/qianwen-free/verify")).toBe(false);

    fireEvent.click(await screen.findByRole("button", { name: "验证默认模型" }));

    await waitFor(() => expect(
      requests.filter((request) => request.url === "/api/model-pools/qianwen-free/verify"),
    ).toHaveLength(1));
    const verifyRequest = requests.find((request) => request.url === "/api/model-pools/qianwen-free/verify")!;
    expect(JSON.parse(String(verifyRequest.init?.body))).toEqual({
      ids: ["pending-default"],
      enablePassed: true,
    });
    await screen.findByText("默认模型验证完成：通过 1/1");
  });

  it("reports default model verification failures and keeps the action available", async () => {
    const pendingVision = member({
      id: "failing-default",
      name: "验证失败视觉",
      isPurposeDefault: true,
      poolEnabled: false,
      capabilityEligible: false,
      capabilityCheckedAt: undefined,
      capabilityStatus: undefined,
    });
    responseFor = (url) => {
      if (url === "/api/model-pools/qianwen-free/verify") return failure("验证服务不可用");
      if (url === "/api/model-pools") {
        return {
          members: [pendingVision],
          summary: {
            total: 1,
            vision: { total: 1, enabled: 0, verified: 0, blocked: 0 },
            text: { total: 0, enabled: 0, verified: 0, blocked: 0 },
          },
        };
      }
      return defaultData(url);
    };
    await renderDialog([pendingVision]);

    fireEvent.click(await screen.findByRole("button", { name: "验证默认模型" }));

    await screen.findAllByText("验证服务不可用");
    expect(screen.getByRole("button", { name: "验证默认模型" })).toBeTruthy();
    expect(requests.filter((request) => request.url === "/api/model-pools/qianwen-free/verify")).toHaveLength(1);
  });

  it("classifies capability snapshots with the configured TTL and server time semantics", async () => {
    vi.setSystemTime(new Date("2026-09-16T06:00:00.000Z"));
    const capabilityMembers = [
      member({
        id: "never",
        name: "从未验证",
        capabilityEligible: false,
        capabilityCheckedAt: undefined,
        capabilityStatus: { text: false, json: false, vision: false },
      }),
      member({
        id: "expired",
        name: "验证过期",
        capabilityEligible: true,
        capabilityCheckedAt: "2026-09-16T05:58:59.999Z",
        capabilityStatus: { text: false, json: false, vision: false },
      }),
      member({
        id: "invalid",
        name: "时间无效",
        capabilityEligible: true,
        capabilityCheckedAt: "not-a-date",
        capabilityStatus: { text: true, json: true, vision: true },
      }),
      member({
        id: "future",
        name: "未来验证",
        capabilityEligible: true,
        capabilityCheckedAt: "2026-09-16T06:00:01.000Z",
        capabilityStatus: { text: true, json: true, vision: true },
      }),
      member({
        id: "failed",
        name: "验证失败",
        capabilityEligible: true,
        capabilityCheckedAt: "2026-09-16T05:59:30.000Z",
        capabilityStatus: {
          text: true,
          json: false,
          vision: true,
          errors: { json: "INVALID_OUTPUT" },
        },
      }),
      member({
        id: "passed",
        name: "验证通过",
        capabilityEligible: false,
        capabilityCheckedAt: "2026-09-16T05:59:30.000Z",
        capabilityStatus: { text: true, json: true, vision: true },
      }),
    ];
    responseFor = (url) => {
      if (url === "/api/model-pool-settings") {
        return { paidDailyTokenLimit: 0, paidMonthlyTokenLimit: 0, capabilityTtlMs: 60_000 };
      }
      return url === "/api/model-pools" ? {
          members: capabilityMembers,
          summary: {
            total: capabilityMembers.length,
            vision: {
              total: capabilityMembers.length,
              enabled: capabilityMembers.length,
              verified: 1,
              blocked: 0,
            },
            text: { total: 0, enabled: 0, verified: 0, blocked: 0 },
          },
        }
        : defaultData(url);
    };
    await renderDialog(capabilityMembers);

    const neverRow = (await screen.findByText("从未验证")).closest("tr")!;
    const expiredRow = screen.getByText("验证过期").closest("tr")!;
    const invalidRow = screen.getByText("时间无效").closest("tr")!;
    const futureRow = screen.getByText("未来验证").closest("tr")!;
    const failedRow = screen.getByText("验证失败").closest("tr")!;
    const passedRow = screen.getByText("验证通过").closest("tr")!;
    expect(within(neverRow).getByText("未验证")).toBeTruthy();
    expect(within(neverRow).getByText("待能力验证")).toBeTruthy();
    expect(within(expiredRow).getAllByText("验证已过期")).toHaveLength(2);
    expect(within(invalidRow).getAllByText("验证已过期")).toHaveLength(2);
    expect(within(futureRow).getAllByText("验证已过期")).toHaveLength(2);
    expect(within(failedRow).getAllByText("能力验证失败")).toHaveLength(2);
    expect(within(passedRow).getByText("已验证")).toBeTruthy();
    expect(within(passedRow).getByText("可调用")).toBeTruthy();
  });

  it("refreshes providers and pool members after provider PATCH without refreshing settings", async () => {
    const staleMember = member({
      name: "旧能力快照",
      capabilityEligible: true,
      capabilityCheckedAt: "2026-09-16T05:59:30.000Z",
    });
    const invalidatedMember = member({
      name: "旧能力快照",
      capabilityEligible: false,
      capabilityCheckedAt: undefined,
      capabilityStatus: undefined,
    });
    let providerLists = 0;
    let poolLists = 0;
    let settingsLists = 0;
    responseFor = (url, init) => {
      if (url === "/api/model-providers/provider-1" && init?.method === "PATCH") {
        return { ...provider, baseUrl: "https://new.example/v1" };
      }
      if (url === "/api/model-providers") {
        providerLists += 1;
        return providerLists === 1
          ? [provider]
          : [{ ...provider, baseUrl: "https://new.example/v1" }];
      }
      if (url === "/api/model-pools") {
        poolLists += 1;
        const currentMembers = poolLists === 1 ? [staleMember] : [invalidatedMember];
        return {
          members: currentMembers,
          summary: {
            total: 1,
            vision: { total: 1, enabled: 1, verified: poolLists === 1 ? 1 : 0, blocked: 0 },
            text: { total: 0, enabled: 0, verified: 0, blocked: 0 },
          },
        };
      }
      if (url === "/api/model-pool-settings") {
        settingsLists += 1;
        return { paidDailyTokenLimit: 0, paidMonthlyTokenLimit: 0, capabilityTtlMs: 86_400_000 };
      }
      return defaultData(url);
    };

    await renderDialog([staleMember]);
    expect(await screen.findByText("已验证")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "服务商凭证" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑千问百炼" }));
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://new.example/v1" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存服务商" }));
    });

    await waitFor(() => {
      expect(providerLists).toBe(2);
      expect(poolLists).toBe(2);
    });
    expect(settingsLists).toBe(1);
    fireEvent.click(screen.getByRole("tab", { name: "模型池" }));
    const row = (await screen.findByText("旧能力快照")).closest("tr")!;
    expect(within(row).queryByText("已验证")).toBeNull();
    expect(within(row).getByText("未验证")).toBeTruthy();
  });
});
