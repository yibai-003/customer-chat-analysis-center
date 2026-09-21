import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  acceptanceModelConfiguration,
  containsConfiguredSecret,
  createAcceptanceAccounts,
  modelEndpointEvidence,
  shouldCreateCredentialProbe,
  signoffEligibility,
  validateSignoffSampleCount,
} from "./lan-acceptance-policy.mjs";

describe("LAN acceptance sign-off policy", () => {
  it("builds drill images with traceable Docker version metadata", () => {
    const script = fs.readFileSync(new URL("./verify-lan-acceptance.ps1", import.meta.url), "utf8");

    expect(script).toContain('--build-arg "APP_VERSION=$appVersion"');
    expect(script).toContain('--build-arg "APP_COMMIT_SHA=$commitSha"');
    expect(script).toContain('--build-arg "APP_BUILD_TIME=$buildTime"');
    expect(script).toContain('--build-arg "APP_IMAGE=$Image"');
  });

  it("uses host-managed provider credentials for sign-off and workstation credentials only for drills", () => {
    const shared = {
      baseUrl: "https://api.model-provider.example/v1",
      providerName: "approved-provider",
      visionModel: "vision-model",
      textModel: "text-model",
    };
    expect(acceptanceModelConfiguration({ ...shared, signoff: true, apiKey: "" })).toEqual({
      configured: true,
      credentialSource: "host-provider",
      missing: [],
    });
    expect(acceptanceModelConfiguration({ ...shared, signoff: true, apiKey: "must-not-leave-host" })).toEqual({
      configured: false,
      credentialSource: "forbidden",
      missing: ["workstation-api-key-forbidden"],
    });
    expect(acceptanceModelConfiguration({ ...shared, signoff: false, apiKey: "" })).toEqual({
      configured: false,
      credentialSource: "missing",
      missing: ["api-key"],
    });
    expect(acceptanceModelConfiguration({ ...shared, signoff: false, apiKey: "drill-secret" })).toEqual({
      configured: true,
      credentialSource: "workstation",
      missing: [],
    });
  });

  it("does not treat an empty host-managed API key as leaked content", () => {
    expect(containsConfiguredSecret("normal response", "")).toBe(false);
    expect(containsConfiguredSecret("normal response", undefined)).toBe(false);
    expect(containsConfiguredSecret("response contains drill-secret", "drill-secret")).toBe(true);
  });

  it("creates workstation credential probes only during drills", () => {
    expect(shouldCreateCredentialProbe(false)).toBe(true);
    expect(shouldCreateCredentialProbe(true)).toBe(false);
  });

  it("rejects local and private model endpoints as real-provider evidence", () => {
    for (const baseUrl of [
      "http://127.0.0.1:8899/v1",
      "http://localhost:8899/v1",
      "http://host.docker.internal:8899/v1",
      "http://172.16.20.178:8899/v1",
      "http://192.168.1.20/v1",
      "http://10.0.0.5/v1",
    ]) {
      expect(modelEndpointEvidence(baseUrl)).toMatchObject({
        configured: true,
        signable: false,
      });
    }
    expect(modelEndpointEvidence("https://api.model-provider.example/v1")).toEqual({
      configured: true,
      host: "api.model-provider.example",
      protocol: "https:",
      signable: true,
      reason: null,
    });
  });

  it("requires 20 to 50 imported records for formal sign-off", () => {
    expect(validateSignoffSampleCount(20)).toBe(20);
    expect(validateSignoffSampleCount(50)).toBe(50);
    expect(() => validateSignoffSampleCount(10)).toThrow(/20-50/);
    expect(() => validateSignoffSampleCount(51)).toThrow(/20-50/);
  });

  it("creates unique role accounts with non-reusable random passwords", () => {
    const first = createAcceptanceAccounts("run-a");
    const second = createAcceptanceAccounts("run-b");
    expect(first.map((account) => account.role)).toEqual(["config", "operator", "reviewer", "readonly"]);
    expect(new Set(first.map((account) => account.username)).size).toBe(4);
    expect(first.every((account) => account.username.includes("run-a"))).toBe(true);
    expect(first.every((account) => account.password.length >= 20)).toBe(true);
    expect(first.map((account) => account.password)).not.toEqual(second.map((account) => account.password));
  });

  it("does not sign off without TLS, real provider, review/export and restore evidence", () => {
    const complete = {
      tlsVerified: true,
      dnsChecked: true,
      model: { configured: true, signable: true, providerName: "approved-provider" },
      importedRecords: 20,
      parsedRecords: 20,
      reviewed: true,
      exported: true,
      backupCreated: true,
      restoreVerified: true,
      crossMachine: true,
    };
    expect(signoffEligibility(complete)).toEqual({ eligible: true, missing: [] });
    expect(signoffEligibility({
      ...complete,
      model: { configured: true, signable: false, providerName: "" },
      reviewed: false,
      restoreVerified: false,
    })).toEqual({
      eligible: false,
      missing: ["real-model-provider", "model-provider-attestation", "review", "restore-verification"],
    });
  });
});
