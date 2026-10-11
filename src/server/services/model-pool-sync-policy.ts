import type {
  BailianCatalogModel,
  BailianExcludedModel,
  BailianPoolCandidate,
  BailianPoolSnapshot,
} from "../../shared/model-pool-sync";

const SUPPORTED_TYPES = new Map<string, "text" | "vision">([
  ["Text", "text"],
  ["Vision", "vision"],
  ["Multimodal", "vision"],
]);
const SAFETY_RATIO = 0.05;

function parseExpiry(value: string): number | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const timestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const match = dateOnly ?? timestamp;
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  if (dateOnly) return Date.parse(`${value}T23:59:59.999+08:00`);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (match[8] !== "Z") {
    const offsetHour = Number(match[8].slice(1, 3));
    const offsetMinute = Number(match[8].slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasText(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function catalogSupports(catalog: BailianCatalogModel, type: string): BailianExcludedModel["reason"] | null {
  if (!hasText(catalog.features) || !catalog.features.includes("structured-outputs")) {
    return "missing_structured_outputs";
  }
  if (!hasText(catalog.capabilities) || !catalog.modalities
    || !hasText(catalog.modalities.input) || !hasText(catalog.modalities.output)) {
    return "missing_capabilities";
  }
  const imageInput = catalog.modalities.input.includes("Image");
  const textInput = catalog.modalities.input.includes("Text");
  const textOutput = catalog.modalities.output.includes("Text");
  if (type === "Text" && (!catalog.capabilities.includes("TG") || !textInput || !textOutput)) {
    return "missing_capabilities";
  }
  if (type === "Vision" && (!catalog.capabilities.includes("VU") || !imageInput || !textOutput)) {
    return "missing_capabilities";
  }
  if (type === "Multimodal" && (!catalog.capabilities.some((item) => item === "VU" || item === "Multimodal-Omni")
    || !imageInput || !textOutput)) {
    return "missing_capabilities";
  }
  return null;
}

export function selectBailianPoolCandidates(
  snapshot: BailianPoolSnapshot,
  now: number,
): { candidates: BailianPoolCandidate[]; excluded: BailianExcludedModel[] } {
  const candidates: BailianPoolCandidate[] = [];
  const excluded: BailianExcludedModel[] = [];
  const catalogs = new Map<string, BailianCatalogModel[]>();
  const quotaCounts = new Map<string, number>();
  for (const model of snapshot.models) {
    const entries = catalogs.get(model.model) ?? [];
    entries.push(model);
    catalogs.set(model.model, entries);
  }
  for (const quota of snapshot.quotas) {
    quotaCounts.set(quota.model, (quotaCounts.get(quota.model) ?? 0) + 1);
  }

  for (const quota of snapshot.quotas) {
    if ((quotaCounts.get(quota.model) ?? 0) !== 1) {
      excluded.push({ model: quota.model, reason: "duplicate_quota" });
      continue;
    }
    const purpose = SUPPORTED_TYPES.get(quota.type);
    if (!purpose) {
      excluded.push({ model: quota.model, reason: "unsupported_type" });
      continue;
    }
    const matching = catalogs.get(quota.model) ?? [];
    if (matching.length === 0) {
      excluded.push({ model: quota.model, reason: "missing_catalog" });
      continue;
    }
    if (matching.length !== 1) {
      excluded.push({ model: quota.model, reason: "duplicate_catalog" });
      continue;
    }
    const model = matching[0];
    if (model.offline === true) {
      excluded.push({ model: quota.model, reason: "offline" });
      continue;
    }
    if (quota.autoStop !== true) {
      excluded.push({ model: quota.model, reason: "auto_stop_disabled" });
      continue;
    }
    if (!Number.isSafeInteger(quota.remaining) || !Number.isSafeInteger(quota.total)
      || quota.remaining <= 0 || quota.total <= 0 || quota.remaining > quota.total) {
      excluded.push({ model: quota.model, reason: "invalid_quota" });
      continue;
    }
    const expiry = parseExpiry(quota.expires);
    if (expiry === null) {
      excluded.push({ model: quota.model, reason: "invalid_expiry" });
      continue;
    }
    if (expiry <= now) {
      excluded.push({ model: quota.model, reason: "expired" });
      continue;
    }
    if (quota.remaining / quota.total <= SAFETY_RATIO) {
      excluded.push({ model: quota.model, reason: "low_safety_margin" });
      continue;
    }
    const capabilityReason = catalogSupports(model, quota.type);
    if (capabilityReason) {
      excluded.push({ model: quota.model, reason: capabilityReason });
      continue;
    }
    const upcoming = model.upcomingOfflineAt ? parseExpiry(model.upcomingOfflineAt) : null;
    if (model.upcomingOfflineAt && upcoming === null) {
      excluded.push({ model: quota.model, reason: "invalid_expiry" });
      continue;
    }
    const effectiveExpiry = upcoming !== null && upcoming < expiry ? upcoming : expiry;
    if (effectiveExpiry <= now) {
      excluded.push({ model: quota.model, reason: "expired" });
      continue;
    }
    candidates.push({
      model: quota.model,
      purpose,
      name: model.name,
      provider: model.provider,
      quotaTotalTokens: quota.total,
      quotaUsedTokens: quota.total - quota.remaining,
      quotaExpiresAt: new Date(effectiveExpiry).toISOString(),
      supportsVision: purpose === "vision",
      qualityTier: "A",
      thinkingMode: false,
      memberType: "general",
    });
  }
  return { candidates, excluded };
}
