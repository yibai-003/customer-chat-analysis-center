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

  it("validates the listen host and the internal reverse proxy allowlists", () => {
    const originalHost = config.listenHost;
    const originalHosts = config.allowedHosts;
    const originalOrigins = config.allowedOrigins;
    try {
      (config as { listenHost: string }).listenHost = "not a host";
      expect(() => validateRuntimeConfig()).toThrow("LISTEN_HOST");
      (config as { listenHost: string }).listenHost = originalHost;

      config.allowedHosts = ["bad host/path"];
      expect(() => validateRuntimeConfig()).toThrow("ALLOWED_HOSTS");
      config.allowedHosts = ["chat.example.lan"];

      config.allowedOrigins = ["chat.example.lan"];
      expect(() => validateRuntimeConfig()).toThrow("ALLOWED_ORIGINS");
      config.allowedOrigins = ["https://chat.example.lan"];

      expect(() => validateRuntimeConfig()).not.toThrow();
    } finally {
      (config as { listenHost: string }).listenHost = originalHost;
      config.allowedHosts = originalHosts;
      config.allowedOrigins = originalOrigins;
    }
  });
});
