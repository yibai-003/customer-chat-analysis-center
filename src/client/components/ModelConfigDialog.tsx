import { useCallback, useEffect, useState } from "react";
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

  const handleChanged = useCallback(async () => {
    await Promise.all([loadProviders(), loadPool(), loadSettings()]);
    setDirty(true);
  }, [loadPool, loadProviders, loadSettings]);

  const closeConsole = () => {
    if (dirty) saved();
    else close();
  };

  return (
    <Modal
      title="模型池控制台"
      subtitle="集中管理服务商凭证、模型路由与调用状态"
      close={closeConsole}
      className="model-console-modal"
    >
      <div className="model-console-tabs" role="tablist" aria-label="模型配置视图">
        {([
          ["providers", "服务商凭证"],
          ["pool", "模型池"],
          ["usage", "调用状态"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? "active" : ""}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div className="model-console-error" role="alert">{error}</div>}

      <div className="model-console-panel" role="tabpanel">
        {tab === "providers" && (
          <ProviderView
            providers={providers}
            api={modelConfigApi}
            refresh={loadProviders}
            changed={handleChanged}
            reportError={setError}
          />
        )}
        {tab === "pool" && (
          <PoolView
            pool={pool}
            settings={settings}
            api={modelConfigApi}
            refreshSettings={loadSettings}
            changed={handleChanged}
            reportError={setError}
          />
        )}
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
