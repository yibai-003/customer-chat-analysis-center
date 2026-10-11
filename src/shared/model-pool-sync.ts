export interface BailianPoolSnapshot {
  providerId: string;
  capturedAt: string;
  accountMatchConfirmed: true;
  quotas: BailianQuotaRecord[];
  models: BailianCatalogModel[];
}

export interface BailianQuotaRecord {
  model: string;
  type: string;
  remaining: number;
  total: number;
  expires: string;
  autoStop: boolean;
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
  quotaTotalTokens: number;
  quotaUsedTokens: number;
  quotaExpiresAt: string;
  supportsVision: boolean;
  qualityTier: "A";
  thinkingMode: false;
  memberType: "general";
}

export type BailianExclusionReason =
  | "unsupported_type"
  | "missing_catalog"
  | "duplicate_catalog"
  | "duplicate_quota"
  | "offline"
  | "missing_structured_outputs"
  | "missing_capabilities"
  | "auto_stop_disabled"
  | "invalid_quota"
  | "expired"
  | "invalid_expiry"
  | "low_safety_margin";

export interface BailianExcludedModel {
  model: string;
  reason: BailianExclusionReason;
}
