import { describe, expect, it, vi } from "vitest";
import { runReadinessCli } from "./readiness-cli";

describe("readiness CLI", () => {
  it("prints JSON and returns zero for a ready instance", () => {
    const write = vi.fn();
    const status = { ready: true, database: true };

    expect(runReadinessCli({ provider: () => status as never, write })).toBe(0);
    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject(status);
  });

  it("returns one for a non-ready instance", () => {
    expect(runReadinessCli({
      provider: () => ({ ready: false }) as never,
      write: () => undefined,
    })).toBe(1);
  });
});
