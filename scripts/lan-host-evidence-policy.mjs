import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_MOUNTS = ["/app/data", "/app/knowledge"];
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function temporaryMount(source) {
  const normalized = String(source ?? "").replaceAll("\\", "/").toLowerCase();
  return normalized.includes("/appdata/local/temp/")
    || normalized.startsWith("/tmp/")
    || normalized.includes("/windows/temp/");
}

export function validateHostEvidence(evidence, context) {
  const errors = [];
  const now = context.now instanceof Date ? context.now : new Date(context.now ?? Date.now());
  const collectedAt = new Date(evidence?.collectedAt ?? "");
  const age = now.getTime() - collectedAt.getTime();

  if (evidence?.schemaVersion !== 2) errors.push("unsupported-schema");
  if (evidence?.mode !== "host-signoff") errors.push("invalid-mode");
  if (evidence?.productionReady !== true) errors.push("host-not-production-ready");
  if (!Number.isFinite(age) || age < -FUTURE_TOLERANCE_MS || age > MAX_AGE_MS) {
    errors.push("host-evidence-stale");
  }

  const hostComputer = String(evidence?.host?.computer ?? "").trim();
  const workstation = String(context.workstation ?? "").trim();
  if (!hostComputer) errors.push("host-computer-missing");
  if (hostComputer && workstation && hostComputer.localeCompare(workstation, undefined, { sensitivity: "accent" }) === 0) {
    errors.push("same-host-and-workstation");
  }

  if (evidence?.entry?.host !== context.entryHost) errors.push("entry-host-mismatch");
  const dnsAddresses = new Set((context.dnsAddresses ?? []).map(String));
  if (!dnsAddresses.has(String(evidence?.entry?.address ?? ""))) errors.push("entry-address-not-in-dns");

  if (!context.expectedImage || evidence?.container?.image !== context.expectedImage) {
    errors.push("unexpected-image");
  }
  if (context.expectedImageId && evidence?.container?.imageId !== context.expectedImageId) {
    errors.push("unexpected-image-id");
  }
  if (!/^sha256:[a-f0-9]{64}$/i.test(String(evidence?.container?.imageId ?? ""))) {
    errors.push("image-id-missing");
  }
  if (!["always", "unless-stopped"].includes(evidence?.container?.restartPolicy)) {
    errors.push("restart-policy");
  }

  const mounts = Array.isArray(evidence?.container?.mounts) ? evidence.container.mounts : [];
  for (const destination of REQUIRED_MOUNTS) {
    const mount = mounts.find((item) => item?.destination === destination);
    if (!mount || mount.type !== "bind") errors.push(`persistent-mount-must-be-bind:${destination}`);
    if (mount?.readOnly !== false) errors.push(`persistent-mount-not-writable:${destination}`);
    if (mount && temporaryMount(mount.source)) errors.push(`temporary-mount:${destination}`);
  }

  if (evidence?.backup?.verified !== true) errors.push("backup-not-verified");
  if (evidence?.restore?.verified !== true) errors.push("restore-not-verified");
  if (evidence?.persistence?.managedKey !== true) errors.push("managed-key-not-persistent");
  if (evidence?.persistence?.mountsVerified !== true) errors.push("mounts-not-verified");
  if (evidence?.persistence?.restartVerified !== true) errors.push("restart-not-verified");
  if (evidence?.singleInstance?.rejected !== true) errors.push("single-instance-not-rejected");

  return { ok: errors.length === 0, errors };
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  const [evidencePath, workstation, entryHost, expectedImage, expectedImageId, dnsCsv = ""] = process.argv.slice(2);
  try {
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    const result = validateHostEvidence(evidence, {
      workstation,
      entryHost,
      expectedImage,
      expectedImageId,
      dnsAddresses: dnsCsv.split(",").map((item) => item.trim()).filter(Boolean),
      now: new Date(),
    });
    process.stdout.write(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    }));
    process.exitCode = 1;
  }
}
