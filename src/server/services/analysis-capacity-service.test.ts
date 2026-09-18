import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loginAdmin } from "../auth/test-admin";
import {
  getAnalysisCapacity,
  recommendAnalysisSettings,
} from "./analysis-capacity-service";

describe("analysis capacity recommendation", () => {
  const recommend = (input: Partial<Parameters<typeof recommendAnalysisSettings>[0]>) => (
    recommendAnalysisSettings({
      logicalProcessors: 20,
      totalMemoryGb: 16,
      freeMemoryGb: 8,
      diskFreeGb: 380,
      activeJobs: 0,
      ...input,
    })
  );

  it("uses a conservative recommendation when free memory is below 3 GB", () => {
    expect(recommendAnalysisSettings({
      logicalProcessors: 20,
      totalMemoryGb: 16,
      freeMemoryGb: 2.4,
      diskFreeGb: 380,
      activeJobs: 0,
    })).toMatchObject({
      concurrency: 1,
      batchSize: 10,
      warnings: [expect.stringContaining("内存")],
    });
  });

  it("recommends concurrency 3 and batch size 30 with 8 GB free memory", () => {
    expect(recommendAnalysisSettings({
      logicalProcessors: 20,
      totalMemoryGb: 16,
      freeMemoryGb: 8,
      diskFreeGb: 380,
      activeJobs: 0,
    })).toEqual({
      concurrency: 3,
      batchSize: 30,
      warnings: [],
    });
  });

  it("reduces the recommendation when another analysis job is active", () => {
    expect(recommendAnalysisSettings({
      logicalProcessors: 20,
      totalMemoryGb: 16,
      freeMemoryGb: 12,
      diskFreeGb: 380,
      activeJobs: 1,
    })).toMatchObject({
      concurrency: 2,
      batchSize: 20,
      warnings: [expect.stringContaining("任务")],
    });
  });

  it("warns when the DATA_DIR disk has less than 10 GB free", () => {
    expect(recommendAnalysisSettings({
      logicalProcessors: 8,
      totalMemoryGb: 16,
      freeMemoryGb: 8,
      diskFreeGb: 9.5,
      activeJobs: 0,
    }).warnings).toEqual([
      expect.stringContaining("磁盘"),
    ]);
  });

  it.each([
    [2.99, 1],
    [3, 2],
    [5.99, 2],
    [6, 3],
    [11.99, 3],
    [12, 4],
  ])("uses the expected memory tier at %s GB free", (freeMemoryGb, concurrency) => {
    expect(recommend({ freeMemoryGb })).toMatchObject({
      concurrency,
      batchSize: concurrency * 10,
    });
  });

  it.each([
    [0, 1],
    [3, 1],
    [64, 4],
  ])("clamps the CPU recommendation for %s logical processors", (logicalProcessors, concurrency) => {
    expect(recommend({ logicalProcessors, freeMemoryGb: 16 })).toMatchObject({
      concurrency,
      batchSize: concurrency * 10,
    });
  });

  it("does not warn at exactly 10 GB disk free", () => {
    expect(recommend({ diskFreeGb: 10 }).warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("磁盘")]),
    );
  });

  it("clamps heavily contended recommendations to concurrency 1", () => {
    expect(recommend({
      logicalProcessors: 64,
      freeMemoryGb: 16,
      activeJobs: 20,
    })).toMatchObject({
      concurrency: 1,
      batchSize: 10,
      warnings: [expect.stringContaining("20")],
    });
  });

  it("collects fixed metrics and exposes recommendation limits", () => {
    const capacity = getAnalysisCapacity({
      logicalProcessors: () => 12,
      totalMemoryBytes: () => 16 * 1024 ** 3,
      freeMemoryBytes: () => 8 * 1024 ** 3,
      diskStats: () => ({ bavail: 8_000_000, bsize: 4096 }),
      activeJobs: () => 0,
    });

    expect(capacity).toEqual({
      metrics: {
        logicalProcessors: 12,
        totalMemoryGb: 16,
        freeMemoryGb: 8,
        diskFreeGb: 30.52,
        activeJobs: 0,
      },
      recommendation: {
        concurrency: 3,
        batchSize: 30,
      },
      allowedRanges: {
        concurrency: { min: 1, max: 6 },
        batchSize: { min: 5, max: 100 },
      },
      warnings: [],
    });
  });

  it("normalizes an empty CPU list to one processor in metrics and recommendation", () => {
    const capacity = getAnalysisCapacity({
      logicalProcessors: () => 0,
      totalMemoryBytes: () => 16 * 1024 ** 3,
      freeMemoryBytes: () => 8 * 1024 ** 3,
      diskStats: () => ({ bavail: 8_000_000, bsize: 4096 }),
      activeJobs: () => 0,
    });

    expect(capacity.metrics.logicalProcessors).toBe(1);
    expect(capacity.recommendation).toEqual({ concurrency: 1, batchSize: 10 });
  });

  it("degrades only the disk metric when statfs fails", () => {
    const capacity = getAnalysisCapacity({
      logicalProcessors: () => 12,
      totalMemoryBytes: () => 16 * 1024 ** 3,
      freeMemoryBytes: () => 8 * 1024 ** 3,
      diskStats: () => {
        throw new Error("EACCES: C:\\secret\\data");
      },
      activeJobs: () => 0,
    });

    expect(capacity.metrics).toMatchObject({
      logicalProcessors: 12,
      totalMemoryGb: 16,
      freeMemoryGb: 8,
      diskFreeGb: null,
      activeJobs: 0,
    });
    expect(capacity.recommendation).toEqual({ concurrency: 3, batchSize: 30 });
    expect(capacity.warnings).toEqual(["磁盘指标不可用，无法检查 DATA_DIR 可用空间。"]);
  });

  it("uses a stable non-sensitive error when a core metric is unavailable", () => {
    expect(() => getAnalysisCapacity({
      logicalProcessors: () => 12,
      totalMemoryBytes: () => {
        throw new Error("wmic failed at C:\\secret\\host");
      },
      freeMemoryBytes: () => 8 * 1024 ** 3,
      diskStats: () => ({ bavail: 8_000_000, bsize: 4096 }),
      activeJobs: () => 0,
    })).toThrow("系统容量指标暂时不可用");
  });
});

describe("analysis capacity API", () => {
  it("returns current metrics and recommendation", async () => {
    const server: Server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;

    try {
      const cookie = await loginAdmin(`http://127.0.0.1:${address.port}`);
      const response = await fetch(`http://127.0.0.1:${address.port}/api/system/analysis-capacity`, { headers: { cookie } });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        data: {
          metrics: {
            logicalProcessors: expect.any(Number),
            totalMemoryGb: expect.any(Number),
            freeMemoryGb: expect.any(Number),
            activeJobs: expect.any(Number),
          },
          recommendation: {
            concurrency: expect.any(Number),
            batchSize: expect.any(Number),
          },
          allowedRanges: {
            concurrency: { min: 1, max: 6 },
            batchSize: { min: 5, max: 100 },
          },
          warnings: expect.any(Array),
        },
        error: null,
      });
      expect(
        body.data.metrics.diskFreeGb === null
        || typeof body.data.metrics.diskFreeGb === "number",
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("returns a stable non-sensitive message when core metrics fail", async () => {
    const server: Server = createApp({
      analysisCapacityProvider: () => {
        throw new Error("wmic failed at C:\\secret\\host");
      },
    }).listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;

    try {
      const cookie = await loginAdmin(`http://127.0.0.1:${address.port}`);
      const response = await fetch(`http://127.0.0.1:${address.port}/api/system/analysis-capacity`, { headers: { cookie } });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        success: false,
        data: null,
        error: "系统容量指标暂时不可用",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
