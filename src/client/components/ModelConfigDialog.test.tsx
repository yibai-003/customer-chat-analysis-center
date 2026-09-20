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
let currentMembers: ModelConfig[];

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
    const summaryFor = (purpose: ModelConfig["purpose"]) => {
      const purposeMembers = currentMembers.filter((model) => model.purpose === purpose);
      return {
        total: purposeMembers.length,
        enabled: purposeMembers.filter((model) => model.isEnabled && model.poolEnabled).length,
        verified: purposeMembers.filter((model) => model.capabilityEligible).length,
        blocked: purposeMembers.filter((model) => model.quotaBlocked || model.cooldownUntil).length,
      };
    };
    return {
      members: currentMembers,
      summary: {
        total: currentMembers.length,
        vision: summaryFor("vision"),
        text: summaryFor("text"),
      },
    };
  }
  if (url === "/api/model-providers") return [provider];
  if (url === "/api/model-pool-settings") {
    return { paidDailyTokenLimit: 0, paidMonthlyTokenLimit: 0, capabilityTtlMs: 86_400_000 };
  }
  if (url.startsWith("/api/model-usage-events")) return usageEvents;
  if (url.startsWith("/api/model-pool-members/")) return currentMembers[0];
  if (url.startsWith("/api/model-providers/")) return provider;
  throw new Error(`Unhandled request: ${url}`);
}

beforeEach(() => {
  requests = [];
  currentMembers = members;
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
  currentMembers = models;
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

  it("tracks none, partial, and full visible selection with selected rows", async () => {
    const first = member({ id: "first", name: "模型甲" });
    const second = member({ id: "second", name: "模型乙" });
    await renderDialog([first, second]);

    const selectAll = (
      await screen.findByRole("checkbox", { name: "全选当前用途成员" })
    ) as HTMLInputElement;
    const firstCheckbox = screen.getByRole(
      "checkbox",
      { name: "选择成员 模型甲" },
    ) as HTMLInputElement;
    const secondCheckbox = screen.getByRole(
      "checkbox",
      { name: "选择成员 模型乙" },
    ) as HTMLInputElement;
    const firstRow = screen.getByText("模型甲").closest("tr")!;
    const secondRow = screen.getByText("模型乙").closest("tr")!;

    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(false);
    expect(firstRow.classList.contains("selected")).toBe(false);
    expect((screen.getByRole("button", { name: "验证已选" }) as HTMLButtonElement).disabled)
      .toBe(true);

    fireEvent.click(firstCheckbox);
    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(true);
    expect(firstRow.classList.contains("selected")).toBe(true);
    expect(secondRow.classList.contains("selected")).toBe(false);
    expect((screen.getByRole("button", { name: "验证已选" }) as HTMLButtonElement).disabled)
      .toBe(false);

    fireEvent.click(selectAll);
    expect(selectAll.checked).toBe(true);
    expect(selectAll.indeterminate).toBe(false);
    expect(firstCheckbox.checked).toBe(true);
    expect(secondCheckbox.checked).toBe(true);
    expect(firstRow.classList.contains("selected")).toBe(true);
    expect(secondRow.classList.contains("selected")).toBe(true);

    fireEvent.click(selectAll);
    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(false);
    expect(firstCheckbox.checked).toBe(false);
    expect(secondCheckbox.checked).toBe(false);
  });

  it("disables visible selection for an empty pool", async () => {
    await renderDialog([]);

    expect((
      await screen.findByRole("checkbox", { name: "全选当前用途成员" }) as HTMLInputElement
    ).disabled).toBe(true);
  });

  it("preserves model identity and exposes truncated values through titles", async () => {
    const identity = member({
      id: "identity",
      name: "用于验证稳定双行布局的超长模型显示名称",
      model: "qwen-model-id-with-a-long-suffix-for-truncation",
      providerName: "用于验证单行省略的超长服务商名称",
    });
    await renderDialog([identity]);

    const row = (await screen.findByText(identity.name)).closest("tr")!;
    expect(within(row).getByText(identity.name).getAttribute("title")).toBe(identity.name);
    expect(within(row).getByText(identity.model).getAttribute("title")).toBe(identity.model);
    expect(within(row).getByText(identity.providerName!).getAttribute("title"))
      .toBe(identity.providerName);
  });

  it("renders quota progress and consistent warning, unlimited, invalid, and exhausted states", async () => {
    vi.setSystemTime(new Date("2026-09-16T03:00:00.000Z"));
    const quotaMembers = [
      member({ id: "normal", name: "正常额度", quotaUsedTokens: 800, quotaTotalTokens: 1_000 }),
      member({
        id: "warning",
        name: "接近阈值",
        quotaUsedTokens: 950,
        quotaTotalTokens: 1_000,
        quotaBlocked: true,
      }),
      member({
        id: "unlimited",
        name: "无限额模型",
        quotaUsedTokens: 10,
        quotaTotalTokens: undefined,
      }),
      member({ id: "invalid", name: "异常额度", quotaUsedTokens: 10, quotaTotalTokens: 0 }),
      member({
        id: "exhausted",
        name: "实际耗尽",
        quotaUsedTokens: 1_000,
        quotaTotalTokens: 1_000,
      }),
      member({
        id: "cooldown-warning",
        name: "阈值冷却",
        quotaUsedTokens: 950,
        quotaTotalTokens: 1_000,
        quotaBlocked: true,
        cooldownUntil: "2026-12-31T00:00:00.000Z",
      }),
      member({
        id: "capability-warning",
        name: "阈值能力失败",
        quotaUsedTokens: 950,
        quotaTotalTokens: 1_000,
        quotaBlocked: true,
        capabilityEligible: false,
        capabilityCheckedAt: "2026-09-16T02:00:00.000Z",
        capabilityStatus: { text: false, json: true, vision: true },
      }),
      member({
        id: "exhausted-conflict",
        name: "耗尽优先",
        quotaUsedTokens: 1_000,
        quotaTotalTokens: 1_000,
        quotaBlocked: true,
        quotaExhaustedAt: "2026-09-20T08:00:00.000Z",
        cooldownUntil: "2026-12-31T00:00:00.000Z",
        capabilityEligible: false,
        capabilityCheckedAt: "2026-09-16T02:00:00.000Z",
        capabilityStatus: { text: false, json: true, vision: true },
      }),
    ];
    await renderDialog(quotaMembers);

    const normalRow = (await screen.findByText("正常额度")).closest("tr")!;
    const normalMeter = normalRow.querySelector(".quota-meter")!;
    expect(within(normalRow).getByRole("progressbar", { name: "正常额度额度 80%" })).toBeTruthy();
    expect(within(normalRow).getByText("800 / 1,000")).toBeTruthy();
    expect(normalRow.cells[5]?.textContent).toBe("200");
    expect(normalMeter.classList.contains("normal")).toBe(true);
    expect(normalMeter.getAttribute("data-quota-state")).toBe("normal");

    const warningRow = screen.getByText("接近阈值").closest("tr")!;
    const warningMeter = warningRow.querySelector(".quota-meter")!;
    expect(within(warningRow).getByRole("progressbar", { name: "接近阈值额度 95%" })).toBeTruthy();
    expect(warningMeter.classList.contains("warning")).toBe(true);
    expect(warningMeter.getAttribute("data-quota-state")).toBe("warning");
    expect(within(warningRow.cells[10]!).getByText("接近安全阈值")).toBeTruthy();
    expect(within(warningRow.cells[10]!).getByText("接近安全阈值")
      .classList.contains("warning")).toBe(true);

    const unlimitedRow = screen.getByText("无限额模型").closest("tr")!;
    const unlimitedMeter = unlimitedRow.querySelector(".quota-meter")!;
    expect(within(unlimitedRow).getByText("不限额")).toBeTruthy();
    expect(unlimitedRow.cells[5]?.textContent).toBe("—");
    expect(unlimitedMeter.classList.contains("unlimited")).toBe(true);
    expect(unlimitedMeter.getAttribute("data-quota-state")).toBe("unlimited");

    const invalidRow = screen.getByText("异常额度").closest("tr")!;
    const invalidMeter = invalidRow.querySelector(".quota-meter")!;
    expect(within(invalidRow).getByText("额度数据异常")).toBeTruthy();
    expect(invalidRow.cells[5]?.textContent).toBe("—");
    expect(invalidMeter.classList.contains("invalid")).toBe(true);
    expect(invalidMeter.getAttribute("data-quota-state")).toBe("invalid");

    const exhaustedRow = screen.getByText("实际耗尽").closest("tr")!;
    const exhaustedMeter = exhaustedRow.querySelector(".quota-meter")!;
    expect(exhaustedMeter.classList.contains("exhausted")).toBe(true);
    expect(exhaustedMeter.getAttribute("data-quota-state")).toBe("exhausted");
    expect(within(exhaustedRow.cells[10]!).getByText("额度已耗尽")
      .classList.contains("danger")).toBe(true);

    const cooldownRow = screen.getByText("阈值冷却").closest("tr")!;
    expect(within(cooldownRow).getByRole("progressbar", { name: "阈值冷却额度 95%" }))
      .toBeTruthy();
    expect(cooldownRow.querySelector(".quota-meter")?.getAttribute("data-quota-state"))
      .toBe("warning");
    expect(within(cooldownRow.cells[10]!).getByText("冷却中")).toBeTruthy();
    expect(within(cooldownRow.cells[10]!).queryByText("接近安全阈值")).toBeNull();

    const capabilityRow = screen.getByText("阈值能力失败").closest("tr")!;
    expect(within(capabilityRow).getByRole("progressbar", { name: "阈值能力失败额度 95%" }))
      .toBeTruthy();
    expect(capabilityRow.querySelector(".quota-meter")?.getAttribute("data-quota-state"))
      .toBe("warning");
    expect(within(capabilityRow.cells[10]!).getByText("能力验证失败")).toBeTruthy();
    expect(within(capabilityRow.cells[10]!).queryByText("接近安全阈值")).toBeNull();

    const exhaustedConflictRow = screen.getByText("耗尽优先").closest("tr")!;
    expect(within(exhaustedConflictRow.cells[10]!).getByText("额度已耗尽")).toBeTruthy();
    expect(within(exhaustedConflictRow.cells[10]!).queryByText("冷却中")).toBeNull();
    expect(within(exhaustedConflictRow.cells[10]!).queryByText("能力验证失败")).toBeNull();
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
      quotaExpiresAt: new Date("2026-12-30T12:30").toISOString(),
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

  it("restores selected members with the established method and request body", async () => {
    const restored = member({ id: "restore-me", name: "待恢复成员" });
    await renderDialog([restored]);

    fireEvent.click(await screen.findByRole("checkbox", { name: "选择成员 待恢复成员" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复已选" }));

    await waitFor(() => expect(requests.some((request) => (
      request.url === "/api/model-pool-members/restore" && request.init?.method === "POST"
    ))).toBe(true));
    const restoreRequest = requests.find((request) => (
      request.url === "/api/model-pool-members/restore"
    ))!;
    expect(restoreRequest.init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(restoreRequest.init?.body))).toEqual({ ids: ["restore-me"] });
  });

  it("saves pool settings with the established method and request body", async () => {
    await renderDialog();

    fireEvent.change(screen.getByLabelText("付费日预算"), { target: { value: "1234" } });
    fireEvent.change(screen.getByLabelText("付费月预算"), { target: { value: "5678" } });
    fireEvent.change(screen.getByLabelText("能力验证有效期（毫秒）"), { target: { value: "9000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存池设置" }));

    await waitFor(() => expect(requests.some((request) => (
      request.url === "/api/model-pool-settings" && request.init?.method === "PATCH"
    ))).toBe(true));
    const settingsRequest = requests.find((request) => (
      request.url === "/api/model-pool-settings" && request.init?.method === "PATCH"
    ))!;
    expect(settingsRequest.init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(settingsRequest.init?.body))).toEqual({
      paidDailyTokenLimit: 1234,
      paidMonthlyTokenLimit: 5678,
      capabilityTtlMs: 9000,
    });
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
    const createRequests = requests.filter((request) => (
      request.url === "/api/model-providers" && request.init?.method === "POST"
    ));
    expect(createRequests).toHaveLength(1);
    expect(JSON.parse(String(createRequests[0].init?.body))).toEqual({
      name: "新服务商",
      baseUrl: "https://new.example/v1",
      isEnabled: true,
      apiKey: "new-secret",
    });
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
      member({
        id: "quota",
        name: "额度耗尽",
        quotaUsedTokens: 1_000_000,
        quotaBlocked: true,
      }),
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
    const quotaRow = screen.getByText("额度耗尽").closest("tr") as HTMLTableRowElement;
    expect(within(quotaRow.cells[10]!).getByText("额度已耗尽")).toBeTruthy();
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

  it("bulk-verifies selected members with enablePassed and reports per-member results", async () => {
    const pooled = member({ id: "pool-a", name: "池内甲", poolEnabled: true, capabilityEligible: true });
    const removed = member({
      id: "pool-b",
      name: "已剔除乙",
      poolEnabled: false,
      capabilityEligible: false,
      capabilityCheckedAt: undefined,
      capabilityStatus: undefined,
    });
    responseFor = (url) => {
      if (url === "/api/model-pool-members/verify") {
        return [
          { id: "pool-a", passed: true },
          { id: "pool-b", passed: false, error: "认证失败", errorCode: "auth" },
        ];
      }
      if (url === "/api/model-pools") {
        return {
          members: [pooled, removed],
          summary: {
            total: 2,
            vision: { total: 2, enabled: 1, verified: 1, blocked: 0 },
            text: { total: 0, enabled: 0, verified: 0, blocked: 0 },
          },
        };
      }
      return defaultData(url);
    };
    await renderDialog([pooled, removed]);

    fireEvent.click(await screen.findByRole("checkbox", { name: "选择成员 已剔除乙" }));
    expect(screen.getByText("已选 1 个")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "验证已选" }));

    await waitFor(() => expect(
      requests.filter((request) => request.url === "/api/model-pool-members/verify"),
    ).toHaveLength(1));
    const verifyRequest = requests.find((request) => request.url === "/api/model-pool-members/verify")!;
    expect(JSON.parse(String(verifyRequest.init?.body))).toEqual({
      ids: ["pool-b"],
      enablePassed: true,
    });
    await screen.findByText("验证完成：通过 1/2");
  });

  it("confirms bulk removal with a reason and warns when the purpose becomes unready", async () => {
    const onlyEligible = member({ id: "only", name: "唯一可用", poolEnabled: true, capabilityEligible: true });
    responseFor = (url) => {
      if (url === "/api/model-pool-members/remove") return { removed: ["only"] };
      if (url === "/api/model-pools") {
        return {
          members: [onlyEligible],
          summary: {
            total: 1,
            vision: { total: 1, enabled: 1, verified: 1, blocked: 0 },
            text: { total: 0, enabled: 0, verified: 0, blocked: 0 },
          },
        };
      }
      return defaultData(url);
    };
    await renderDialog([onlyEligible]);

    fireEvent.click(await screen.findByRole("checkbox", { name: "选择成员 唯一可用" }));
    fireEvent.click(screen.getByRole("button", { name: "剔除已选" }));
    expect(await screen.findByText(/视觉用途将进入未就绪状态/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("剔除原因"), { target: { value: "quota" } });
    fireEvent.click(screen.getByRole("button", { name: "确认剔除" }));

    await waitFor(() => expect(
      requests.filter((request) => request.url === "/api/model-pool-members/remove"),
    ).toHaveLength(1));
    const removeRequest = requests.find((request) => request.url === "/api/model-pool-members/remove")!;
    expect(JSON.parse(String(removeRequest.init?.body))).toEqual({ ids: ["only"], reason: "quota" });
    await screen.findByText(/已剔除 1 个成员/);
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
    vi.setSystemTime(new Date("2026-09-16T06:00:00.000Z"));
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
        const refreshedMembers = poolLists === 1 ? [staleMember] : [invalidatedMember];
        return {
          members: refreshedMembers,
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
