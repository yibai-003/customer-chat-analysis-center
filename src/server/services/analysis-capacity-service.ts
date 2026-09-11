import fs from "node:fs";
import os from "node:os";
import { config } from "../config";
import { countActiveJobRuns } from "../db/repositories";
import type {
  AnalysisCapacity,
  AnalysisCapacityMetrics,
  AnalysisRecommendation,
} from "../../shared/types";

const BYTES_PER_GB = 1024 ** 3;
const CORE_METRICS_ERROR = "系统容量指标暂时不可用";
const DISK_METRICS_WARNING = "磁盘指标不可用，无法检查 DATA_DIR 可用空间。";

export interface AnalysisCapacityDependencies {
  logicalProcessors: () => number;
  totalMemoryBytes: () => number;
  freeMemoryBytes: () => number;
  diskStats: () => { bavail: number; bsize: number };
  activeJobs: () => number;
}

const defaultDependencies: AnalysisCapacityDependencies = {
  logicalProcessors: () => os.cpus().length,
  totalMemoryBytes: () => os.totalmem(),
  freeMemoryBytes: () => os.freemem(),
  diskStats: () => fs.statfsSync(config.dataDir),
  activeJobs: countActiveJobRuns,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundGb(bytes: number) {
  return Math.round((bytes / BYTES_PER_GB) * 100) / 100;
}

function normalizeLogicalProcessors(value: number) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function requireNonNegative(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error(CORE_METRICS_ERROR);
  return value;
}

export function recommendAnalysisSettings(
  input: AnalysisCapacityMetrics,
): AnalysisRecommendation & { warnings: string[] } {
  const logicalProcessors = normalizeLogicalProcessors(input.logicalProcessors);
  const freeMemoryGb = Number.isFinite(input.freeMemoryGb)
    ? Math.max(0, input.freeMemoryGb)
    : 0;
  const diskFreeGb = input.diskFreeGb !== null && Number.isFinite(input.diskFreeGb)
    ? Math.max(0, input.diskFreeGb)
    : null;
  const activeJobs = Number.isFinite(input.activeJobs)
    ? Math.max(0, Math.floor(input.activeJobs))
    : 0;

  const cpuLimit = clamp(Math.floor(logicalProcessors / 4), 1, 4);
  const memoryLimit = freeMemoryGb < 3 ? 1 : freeMemoryGb < 6 ? 2 : freeMemoryGb < 12 ? 3 : 4;
  const concurrency = clamp(
    Math.floor(Math.min(cpuLimit, memoryLimit) / Math.max(1, activeJobs + 1)),
    1,
    4,
  );
  const batchSize = clamp(concurrency * 10, 10, 40);
  const warnings: string[] = [];

  if (freeMemoryGb < 3) {
    warnings.push("当前可用内存低于 3 GB，建议关闭其他应用后再解析。");
  }
  if (diskFreeGb !== null && diskFreeGb < 10) {
    warnings.push("DATA_DIR 所在磁盘可用空间低于 10 GB，请先释放空间。");
  }
  if (activeJobs > 0) {
    warnings.push(`当前有 ${activeJobs} 个解析任务正在运行，推荐并发已相应降低。`);
  }

  return { concurrency, batchSize, warnings };
}

export function getAnalysisCapacity(
  dependencies: AnalysisCapacityDependencies = defaultDependencies,
): AnalysisCapacity {
  let metrics: AnalysisCapacityMetrics;
  try {
    metrics = {
      logicalProcessors: normalizeLogicalProcessors(dependencies.logicalProcessors()),
      totalMemoryGb: roundGb(requireNonNegative(dependencies.totalMemoryBytes())),
      freeMemoryGb: roundGb(requireNonNegative(dependencies.freeMemoryBytes())),
      diskFreeGb: null,
      activeJobs: Math.floor(requireNonNegative(dependencies.activeJobs())),
    };
  } catch {
    throw new Error(CORE_METRICS_ERROR);
  }

  let diskMetricsUnavailable = false;
  try {
    const diskStats = dependencies.diskStats();
    metrics.diskFreeGb = roundGb(requireNonNegative(diskStats.bavail * diskStats.bsize));
  } catch {
    diskMetricsUnavailable = true;
  }

  const { warnings, ...recommendation } = recommendAnalysisSettings(metrics);
  if (diskMetricsUnavailable) warnings.push(DISK_METRICS_WARNING);

  return {
    metrics,
    recommendation,
    allowedRanges: {
      concurrency: { min: 1, max: 6 },
      batchSize: { min: 5, max: 100 },
    },
    warnings,
  };
}
