export interface BailianPoolSnapshot {
  providerId: string;
  capturedAt: string;
  accountMatchConfirmed: true;
  models: BailianCatalogModel[];
}

export interface BailianCatalogModel {
  model: string;
  name: string;
  provider: string;
  capabilities: string[];
  modalities: { input: string[]; output: string[] };
  features: string[];
  offline?: boolean;
  upcomingOfflineAt?: string | null;
}

export interface BailianPoolCandidate {
  model: string;
  purpose: "text" | "vision";
  name: string;
  provider: string;
  supportsVision: boolean;
  qualityTier: "A";
  thinkingMode: false;
  memberType: "general";
}

export type BailianExclusionReason =
  | "unsupported_type"
  | "duplicate_catalog"
  | "offline"
  | "missing_structured_outputs"
  | "missing_capabilities"
  | "invalid_expiry"
  | "expired";

export interface BailianExcludedModel {
  model: string;
  reason: BailianExclusionReason;
}
