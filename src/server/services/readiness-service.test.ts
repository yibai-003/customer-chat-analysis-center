import { describe, expect, it } from "vitest";
import { getReadinessStatus } from "./readiness-service";

const checks = {
  vision: { verified: true },
  text: { verified: true },
};

describe("readiness service", () => {
  it("is ready only when disk and both model purposes are ready", () => {
    expect(getReadinessStatus({
      dataDir: "C:/data",
      minFreeDiskMb: 512,
      statfs: () => ({ bavail: 2048, bsize: 1024 * 1024 }),
      modelChecks: () => checks as never,
      modelActions: () => ({ verifyPoolMemberIds: [] }) as never,
    })).toMatchObject({
      ready: true,
      database: true,
      freeDiskMb: 2048,
      models: { vision: true, text: true },
    });
  });

  it("reports an actionable non-ready result", () => {
    const result = getReadinessStatus({
      dataDir: "C:/data",
      minFreeDiskMb: 512,
      statfs: () => ({ bavail: 100, bsize: 1024 * 1024 }),
      modelChecks: () => ({ ...checks, text: { verified: false } }) as never,
      modelActions: () => ({ verifyPoolMemberIds: ["text-model"] }) as never,
    });

    expect(result.ready).toBe(false);
    expect(result.models).toEqual({ vision: true, text: false });
    expect(result.actions).toEqual({ verifyPoolMemberIds: ["text-model"] });
  });
});
