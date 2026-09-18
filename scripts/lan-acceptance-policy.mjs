import crypto from "node:crypto";
import net from "node:net";

const ACCEPTANCE_ROLES = [
  ["config", "验收配置"],
  ["operator", "验收操作"],
  ["reviewer", "验收审核"],
  ["readonly", "验收只读"],
];

function privateIpv4(host) {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function localModelHost(host) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "0.0.0.0", "::", "::1", "host.docker.internal"].includes(normalized)) return true;
  if (normalized.endsWith(".localhost") || normalized.endsWith(".local")) return true;
  if (net.isIP(normalized) === 4) return privateIpv4(normalized);
  if (net.isIP(normalized) === 6) {
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  return false;
}

export function modelEndpointEvidence(baseUrl) {
  if (!baseUrl) return { configured: false, host: null, protocol: null, signable: false, reason: "not-configured" };
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { configured: true, host: null, protocol: null, signable: false, reason: "invalid-url" };
  }
  const reason = parsed.protocol !== "https:"
    ? "https-required"
    : localModelHost(parsed.hostname)
      ? "local-or-private-endpoint"
      : null;
  return {
    configured: true,
    host: parsed.hostname,
    protocol: parsed.protocol,
    signable: reason === null,
    reason,
  };
}

export function validateSignoffSampleCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 20 || count > 50) {
    throw new Error(`正式验收样本必须包含 20-50 条记录，实际 ${value}`);
  }
  return count;
}

export function acceptanceModelConfiguration(input) {
  const missing = [];
  if (!input.baseUrl?.trim()) missing.push("base-url");
  if (!input.visionModel?.trim()) missing.push("vision-model");
  if (!input.textModel?.trim()) missing.push("text-model");
  if (input.signoff) {
    if (!input.providerName?.trim()) missing.push("provider");
    if (input.apiKey?.trim()) missing.push("workstation-api-key-forbidden");
  } else if (!input.apiKey?.trim()) {
    missing.push("api-key");
  }
  return {
    configured: missing.length === 0,
    credentialSource: missing.includes("workstation-api-key-forbidden")
      ? "forbidden"
      : missing.length
        ? "missing"
      : input.signoff
        ? "host-provider"
        : "workstation",
    missing,
  };
}

export function containsConfiguredSecret(value, secret) {
  return typeof secret === "string" && secret.length > 0 && String(value).includes(secret);
}

export function shouldCreateCredentialProbe(signoff) {
  return !signoff;
}

export function createAcceptanceAccounts(runId = crypto.randomBytes(5).toString("hex")) {
  const suffix = String(runId).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24)
    || crypto.randomBytes(5).toString("hex");
  return ACCEPTANCE_ROLES.map(([role, displayName]) => ({
    role,
    username: `acceptance-${role}-${suffix}`,
    password: crypto.randomBytes(18).toString("base64url"),
    displayName,
  }));
}

export function signoffEligibility(input) {
  const missing = [];
  if (!input.tlsVerified) missing.push("trusted-tls");
  if (!input.dnsChecked) missing.push("internal-dns");
  if (!input.model?.configured || !input.model?.signable) missing.push("real-model-provider");
  if (!input.model?.providerName?.trim()) missing.push("model-provider-attestation");
  try {
    validateSignoffSampleCount(input.importedRecords);
  } catch {
    missing.push("sample-count");
  }
  if (!Number.isInteger(input.parsedRecords) || input.parsedRecords < input.importedRecords) missing.push("model-analysis");
  if (!input.reviewed) missing.push("review");
  if (!input.exported) missing.push("export");
  if (!input.backupCreated) missing.push("backup");
  if (!input.restoreVerified) missing.push("restore-verification");
  if (!input.crossMachine) missing.push("cross-machine");
  return { eligible: missing.length === 0, missing };
}
