import { useState } from "react";
import type { AnalysisCapacity, AnalysisJobOptions } from "../../shared/types";
import { Modal } from "./Modal";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function AnalysisRunDialog({
  capacity,
  onConfirm,
  onCancel,
  selectedCount,
}: {
  capacity: AnalysisCapacity;
  selectedCount?: number | null;
  onConfirm: (options: Required<Pick<AnalysisJobOptions, "concurrency" | "batchSize" | "maxPaidTokens">>) => void;
  onCancel: () => void;
}) {
  const [concurrency, setConcurrency] = useState(capacity.recommendation.concurrency);
  const [batchSize, setBatchSize] = useState(capacity.recommendation.batchSize);
  const [maxPaidTokens, setMaxPaidTokens] = useState("0");
  const [paidTokenError, setPaidTokenError] = useState(false);
  const { metrics, recommendation, allowedRanges } = capacity;
  const parsedMaxPaidTokens = Number(maxPaidTokens);
  const validMaxPaidTokens = maxPaidTokens.trim() !== ""
    && Number.isSafeInteger(parsedMaxPaidTokens)
    && parsedMaxPaidTokens >= 0
    && parsedMaxPaidTokens <= 100_000_000;
  const exceedsRecommendation = (
    concurrency > recommendation.concurrency
    || batchSize > recommendation.batchSize
  );
  const updateConcurrency = (value: number) => {
    setConcurrency(clamp(value, allowedRanges.concurrency.min, allowedRanges.concurrency.max));
  };
  const updateBatchSize = (value: number) => {
    setBatchSize(clamp(value, allowedRanges.batchSize.min, allowedRanges.batchSize.max));
  };

  return <Modal
    title="批量解析运行设置"
    subtitle="SYSTEM CAPACITY / RUN OPTIONS"
    close={onCancel}
    className="analysis-run-modal"
  >
    <dl className="capacity-metrics">
      <div><dt>CPU</dt><dd>{metrics.logicalProcessors} 个逻辑处理器</dd></div>
      <div><dt>总内存</dt><dd>{metrics.totalMemoryGb} GB</dd></div>
      <div><dt>可用内存</dt><dd>{metrics.freeMemoryGb} GB</dd></div>
      <div><dt>磁盘可用</dt><dd>{metrics.diskFreeGb === null ? "不可用" : `${metrics.diskFreeGb} GB`}</dd></div>
      <div><dt>活跃任务</dt><dd>{metrics.activeJobs} 个</dd></div>
    </dl>

    <div className="analysis-recommendation">
      <span>系统推荐</span>
      <strong>并发 {recommendation.concurrency} · 每批 {recommendation.batchSize} 条</strong>
    </div>

    {typeof selectedCount === "number" && <div className="analysis-target">
      本次只解析已选 {selectedCount} 条记录
    </div>}

    {capacity.warnings.length > 0 && <div className="capacity-warnings">
      {capacity.warnings.map((warning) => <p key={warning}>{warning}</p>)}
    </div>}

    <div className="analysis-run-fields">
      <label>
        AI 并发数
        <input
          aria-label="AI 并发数"
          type="number"
          min={allowedRanges.concurrency.min}
          max={allowedRanges.concurrency.max}
          step={1}
          value={concurrency}
          onChange={(event) => updateConcurrency(Number(event.target.value))}
        />
        <small>{allowedRanges.concurrency.min}-{allowedRanges.concurrency.max}</small>
      </label>
      <label>
        每批记录数
        <input
          aria-label="每批记录数"
          type="number"
          min={allowedRanges.batchSize.min}
          max={allowedRanges.batchSize.max}
          step={1}
          value={batchSize}
          onChange={(event) => updateBatchSize(Number(event.target.value))}
        />
        <small>{allowedRanges.batchSize.min}-{allowedRanges.batchSize.max}</small>
      </label>
      <label>
        最大付费 Token
        <input
          aria-label="最大付费 Token"
          type="number"
          min={0}
          max={100_000_000}
          step={1000}
          value={maxPaidTokens}
          aria-invalid={paidTokenError}
          onChange={(event) => {
            setMaxPaidTokens(event.target.value);
            setPaidTokenError(false);
          }}
        />
        <small>0 表示仅使用免费池；免费额度不可用时任务暂停并等待处理。</small>
      </label>
    </div>

    {paidTokenError && <div className="form-error" role="alert">
      最大付费 Token 必须是 0 到 100000000 之间的整数。
    </div>}

    {exceedsRecommendation && <div className="analysis-load-warning">
      当前设置高于系统推荐值，可能增加内存占用或模型接口负载。
    </div>}

    <div className="modal-actions">
      <button className="button light" onClick={onCancel}>取消</button>
      <button
        className="button dark"
        onClick={() => {
          if (!validMaxPaidTokens) {
            setPaidTokenError(true);
            return;
          }
          onConfirm({ concurrency, batchSize, maxPaidTokens: parsedMaxPaidTokens });
        }}
      >
        按此配置开始解析
      </button>
    </div>
  </Modal>;
}
