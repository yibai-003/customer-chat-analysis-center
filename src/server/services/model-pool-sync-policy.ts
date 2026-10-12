import type {
  BailianCatalogModel,
  BailianExcludedModel,
  BailianPoolCandidate,
  BailianPoolSnapshot,
} from "../../shared/model-pool-sync";

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
  if (match[8] !== "Z" && (Number(match[8].slice(1, 3)) > 23 || Number(match[8].slice(4, 6)) > 59)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isQianwenModelId(model: string): boolean {
  return /^qwen/i.test(model);
}

function catalogSupports(catalog: BailianCatalogModel): BailianExcludedModel["reason"] | null {
  if (!Array.isArray(catalog.features) || !catalog.features.includes("structured-outputs")) {
    return "missing_structured_outputs";
  }
  if (!Array.isArray(catalog.capabilities) || !catalog.modalities
    || !Array.isArray(catalog.modalities.input) || !Array.isArray(catalog.modalities.output)) {
    return "missing_capabilities";
  }
  const imageInput = catalog.modalities.input.includes("Image");
  const textInput = catalog.modalities.input.includes("Text");
  const textOutput = catalog.modalities.output.includes("Text");
  if (!textOutput || (!imageInput && (!textInput || !catalog.capabilities.includes("TG")))) {
    return "missing_capabilities";
  }
  if (imageInput && !catalog.capabilities.some((item) => item === "VU" || item === "Multimodal-Omni")) {
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
  for (const model of snapshot.models) {
    if (!isQianwenModelId(model.model)) {
      excluded.push({ model: model.model, reason: "unsupported_type" });
      continue;
    }
    const entries = catalogs.get(model.model) ?? [];
    entries.push(model);
    catalogs.set(model.model, entries);
  }

  for (const [modelId, matching] of catalogs) {
    if (matching.length !== 1) {
      excluded.push({ model: modelId, reason: "duplicate_catalog" });
      continue;
    }
    const model = matching[0];
    if (model.offline === true) {
      excluded.push({ model: modelId, reason: "offline" });
      continue;
    }
    const capabilityReason = catalogSupports(model);
    if (capabilityReason) {
      excluded.push({ model: modelId, reason: capabilityReason });
      continue;
    }
    if (model.upcomingOfflineAt) {
      const upcoming = parseExpiry(model.upcomingOfflineAt);
      if (upcoming === null) {
        excluded.push({ model: modelId, reason: "invalid_expiry" });
        continue;
      }
      if (upcoming <= now) {
        excluded.push({ model: modelId, reason: "expired" });
        continue;
      }
    }
    const purpose = model.modalities.input.includes("Image") ? "vision" : "text";
    candidates.push({
      model: modelId,
      purpose,
      name: model.name,
      provider: model.provider,
      supportsVision: purpose === "vision",
      qualityTier: "A",
      thinkingMode: false,
      memberType: "general",
    });
  }
  return { candidates, excluded };
}
