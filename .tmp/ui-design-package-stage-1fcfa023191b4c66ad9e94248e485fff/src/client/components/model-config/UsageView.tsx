import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { ModelConfig, ModelPurpose, ModelUsageEvent } from "../../../shared/types";

type EventType = ModelUsageEvent["eventType"] | "";

const eventLabels: Record<ModelUsageEvent["eventType"], string> = {
  success: "成功",
  failure: "失败",
  switch: "切换模型",
  quota_exhausted: "额度耗尽",
  cooldown: "进入冷却",
  paid_blocked: "付费预算阻止",
  usage_unknown: "用量未知",
};

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function UsageView({
  models,
  events,
  setEvents,
  api,
  reportError,
}: {
  models: ModelConfig[];
  events: ModelUsageEvent[];
  setEvents: Dispatch<SetStateAction<ModelUsageEvent[]>>;
  api: <T>(url: string, options?: RequestInit) => Promise<T>;
  reportError: (message: string) => void;
}) {
  const [purpose, setPurpose] = useState<ModelPurpose | "">("");
  const [modelConfigId, setModelConfigId] = useState("");
  const [eventType, setEventType] = useState<EventType>("");
  const modelNames = useMemo(
    () => new Map(models.map((model) => [model.id, model.name])),
    [models],
  );

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams();
    if (purpose) params.set("purpose", purpose);
    if (modelConfigId) params.set("modelConfigId", modelConfigId);
    if (eventType) params.set("eventType", eventType);
    params.set("limit", "100");
    api<ModelUsageEvent[]>(`/api/model-usage-events?${params.toString()}`)
      .then((data) => {
        if (active) setEvents(data);
      })
      .catch((error) => {
        if (active) reportError(error instanceof Error ? error.message : "调用状态加载失败");
      });
    return () => {
      active = false;
    };
  }, [api, eventType, modelConfigId, purpose, reportError, setEvents]);

  return (
    <section className="usage-view" aria-label="调用状态">
      <div className="model-console-section-head">
        <div>
          <h3>调用状态</h3>
          <p>仅展示路由元数据和 Token 用量，不包含提示词、响应正文或凭证。</p>
        </div>
      </div>

      <div className="usage-filters">
        <label>
          用途筛选
          <select value={purpose} onChange={(event) => setPurpose(event.target.value as ModelPurpose | "")}>
            <option value="">全部用途</option>
            <option value="vision">视觉</option>
            <option value="text">文本</option>
          </select>
        </label>
        <label>
          模型筛选
          <select value={modelConfigId} onChange={(event) => setModelConfigId(event.target.value)}>
            <option value="">全部模型</option>
            {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
          </select>
        </label>
        <label>
          事件筛选
          <select value={eventType} onChange={(event) => setEventType(event.target.value as EventType)}>
            <option value="">全部事件</option>
            {Object.entries(eventLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="model-table-scroll">
        <table className="model-usage-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>操作</th>
              <th>事件</th>
              <th>输入 Tokens</th>
              <th>输出 Tokens</th>
              <th>错误码</th>
              <th>记录 / 字段</th>
              <th>耗时</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>
                  <strong>{modelNames.get(event.modelConfigId) ?? event.modelConfigId}</strong>
                  <small>{event.purpose === "vision" ? "视觉" : "文本"}</small>
                </td>
                <td>{event.operation ?? "未记录"}</td>
                <td><span className={`usage-event ${event.eventType}`}>{eventLabels[event.eventType]}</span></td>
                <td>{event.inputTokens ?? "未知"}</td>
                <td>{event.outputTokens ?? "未知"}</td>
                <td>{event.errorCode ?? "无"}</td>
                <td>{event.recordId || event.fieldId ? `${event.recordId ?? "-"} / ${event.fieldId ?? "-"}` : "无"}</td>
                <td>{event.durationMs == null ? "未知" : `${event.durationMs}ms`}</td>
                <td>{formatDate(event.createdAt)}</td>
              </tr>
            ))}
            {events.length === 0 && (
              <tr><td colSpan={9} className="model-console-empty">暂无符合筛选条件的调用事件。</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
