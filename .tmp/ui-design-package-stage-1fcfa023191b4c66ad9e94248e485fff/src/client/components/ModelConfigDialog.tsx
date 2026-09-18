import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import type {
  ModelConfig,
  ModelPoolSettings,
  ModelProvider,
  ModelUsageEvent,
} from "../../shared/types";
import { Modal } from "./Modal";
import { PoolView, type PoolData } from "./model-config/PoolView";
import { ProviderView } from "./model-config/ProviderView";
import { UsageView } from "./model-config/UsageView";

export async function modelConfigApi<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || "请求失败");
  }
  return body.data as T;
}

type ConsoleTab = "providers" | "pool" | "usage";
const consoleTabs: ReadonlyArray<{ value: ConsoleTab; label: string }> = [
  { value: "providers", label: "服务商凭证" },
  { value: "pool", label: "模型池" },
  { value: "usage", label: "调用状态" },
];

const emptySummary: PoolData["summary"] = {
  total: 0,
  vision: { total: 0, enabled: 0, verified: 0, blocked: 0 },
  text: { total: 0, enabled: 0, verified: 0, blocked: 0 },
};

export function ModelConfigDialog({
  models,
  close,
  saved,
}: {
  models: ModelConfig[];
  close: () => void;
  saved: () => void;
}) {
  const [tab, setTab] = useState<ConsoleTab>("pool");
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [pool, setPool] = useState<PoolData>({ members: models, summary: emptySummary });
  const [settings, setSettings] = useState<ModelPoolSettings>({
    paidDailyTokenLimit: 0,
    paidMonthlyTokenLimit: 0,
    capabilityTtlMs: 86_400_000,
  });
  const [usageEvents, setUsageEvents] = useState<ModelUsageEvent[]>([]);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);

  const loadProviders = useCallback(async () => {
    setProviders(await modelConfigApi<ModelProvider[]>("/api/model-providers"));
  }, []);

  const loadPool = useCallback(async () => {
    setPool(await modelConfigApi<PoolData>("/api/model-pools"));
  }, []);

  const loadSettings = useCallback(async () => {
    setSettings(await modelConfigApi<ModelPoolSettings>("/api/model-pool-settings"));
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      modelConfigApi<ModelProvider[]>("/api/model-providers"),
      modelConfigApi<PoolData>("/api/model-pools"),
      modelConfigApi<ModelPoolSettings>("/api/model-pool-settings"),
    ]).then(([nextProviders, nextPool, nextSettings]) => {
      if (!active) return;
      setProviders(nextProviders);
      setPool(nextPool);
      setSettings(nextSettings);
    }).catch((loadError) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "模型控制台加载失败");
    });
    return () => {
      active = false;
    };
  }, []);

  const markDirty = useCallback(() => {
    setDirty(true);
  }, []);

  const closeConsole = () => {
    if (dirty) saved();
    else close();
  };

  const selectTab = (nextTab: ConsoleTab, focus = false) => {
    setTab(nextTab);
    if (focus) document.getElementById(`model-console-tab-${nextTab}`)?.focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % consoleTabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + consoleTabs.length) % consoleTabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = consoleTabs.length - 1;
    if (nextIndex == null) return;
    event.preventDefault();
    selectTab(consoleTabs[nextIndex].value, true);
  };

  return (
    <Modal
      title="模型池控制台"
      subtitle="集中管理服务商凭证、模型路由与调用状态"
      close={closeConsole}
      className="model-console-modal"
    >
      <div className="model-console-tabs" role="tablist" aria-label="模型配置视图">
        {consoleTabs.map(({ value, label }, index) => (
          <button
            key={value}
            id={`model-console-tab-${value}`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`model-console-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            className={tab === value ? "active" : ""}
            onClick={() => selectTab(value)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div className="model-console-error" role="alert">{error}</div>}

      <div
        id="model-console-panel-providers"
        className="model-console-panel"
        role="tabpanel"
        aria-labelledby="model-console-tab-providers"
        hidden={tab !== "providers"}
      >
        {tab === "providers" && (
          <ProviderView
            providers={providers}
            api={modelConfigApi}
            refreshProviders={loadProviders}
            refreshPool={loadPool}
            markDirty={markDirty}
            reportError={setError}
          />
        )}
      </div>
      <div
        id="model-console-panel-pool"
        className="model-console-panel"
        role="tabpanel"
        aria-labelledby="model-console-tab-pool"
        hidden={tab !== "pool"}
      >
        {tab === "pool" && (
          <PoolView
            pool={pool}
            settings={settings}
            api={modelConfigApi}
            refreshPool={loadPool}
            refreshSettings={loadSettings}
            markDirty={markDirty}
            reportError={setError}
          />
        )}
      </div>
      <div
        id="model-console-panel-usage"
        className="model-console-panel"
        role="tabpanel"
        aria-labelledby="model-console-tab-usage"
        hidden={tab !== "usage"}
      >
        {tab === "usage" && (
          <UsageView
            models={pool.members}
            events={usageEvents}
            setEvents={setUsageEvents}
            api={modelConfigApi}
            reportError={setError}
          />
        )}
      </div>
    </Modal>
  );
}
