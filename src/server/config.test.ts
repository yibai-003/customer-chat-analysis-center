import { describe, expect, it } from "vitest";
import { config, validateRuntimeConfig } from "./config";

describe("runtime configuration", () => {
  it("accepts the local development defaults", () => {
    expect(() => validateRuntimeConfig()).not.toThrow();
    expect(config.port).toBeGreaterThan(0);
  });

  it("rejects invalid numeric configuration", () => {
    const originalPort = config.port;
    (config as { port: number }).port = 0;
    expect(() => validateRuntimeConfig()).toThrow("PORT");
    (config as { port: number }).port = originalPort;
  });
});
