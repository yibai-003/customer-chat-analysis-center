import type { ModelPurpose, ModelQualityTier } from "../../shared/types";

export interface QianwenPresetMember {
  model: string;
  purpose: ModelPurpose;
  qualityTier: ModelQualityTier;
  thinkingMode: boolean;
  memberType: "general" | "ocr";
  quotaTotalTokens: number;
  initialUsedTokens?: number;
  quotaExpiresAt: string;
  priority: number;
}

export const QIANWEN_FREE_POOL_PRESET_VERSION = 1;
const OCT_08 = "2026-10-08T23:59:59+08:00";

const member = (
  model: string,
  purpose: ModelPurpose,
  qualityTier: ModelQualityTier,
  quotaExpiresAt: string,
  priority: number,
  thinkingMode = false,
  memberType: "general" | "ocr" = "general",
): QianwenPresetMember => ({
  model,
  purpose,
  qualityTier,
  thinkingMode,
  memberType,
  quotaTotalTokens: 1_000_000,
  quotaExpiresAt,
  priority,
});

const members: QianwenPresetMember[] = [
  { ...member("qwen3-vl-plus", "vision", "A", OCT_08, 10), initialUsedTokens: 803_700 },
  member("qwen3-vl-plus-2025-12-19", "vision", "A", OCT_08, 20),
  member("qwen3-vl-plus-2025-09-23", "vision", "A", OCT_08, 30),
  member("qwen3-vl-235b-a22b-instruct", "vision", "A", OCT_08, 40),
  member("qwen3-vl-235b-a22b-thinking", "vision", "A", OCT_08, 50, true),
  member("qwen3-vl-32b-instruct", "vision", "A", OCT_08, 60),
  member("qwen3-vl-32b-thinking", "vision", "A", OCT_08, 70, true),
  member("qwen3-vl-30b-a3b-instruct", "vision", "A", OCT_08, 80),
  member("qwen3-vl-30b-a3b-thinking", "vision", "A", OCT_08, 90, true),
  member("qwen3.5-omni-plus", "vision", "A", OCT_08, 100),
  member("qwen3.5-omni-plus-2026-03-15", "vision", "A", OCT_08, 110),
  member("qwen-vl-max-2025-08-13", "vision", "A", OCT_08, 120),
  member("qwen-vl-max-2025-04-08", "vision", "A", OCT_08, 130),
  member("qwen3-vl-flash", "vision", "B", OCT_08, 140),
  member("qwen3-vl-flash-2026-01-22", "vision", "B", OCT_08, 150),
  member("qwen3-vl-flash-2025-10-15", "vision", "B", OCT_08, 160),
  member("qwen3.5-omni-flash", "vision", "B", OCT_08, 170),
  member("qwen3.5-omni-flash-2026-03-15", "vision", "B", OCT_08, 180),
  member("qwen3-vl-8b-instruct", "vision", "C", OCT_08, 190),
  member("qwen3-vl-8b-thinking", "vision", "C", OCT_08, 200, true),
  member("qwen3.5-ocr", "vision", "C", OCT_08, 210, false, "ocr"),
  member("qwen-vl-ocr", "vision", "C", OCT_08, 220, false, "ocr"),
  { ...member("qwen-plus", "text", "A", OCT_08, 10), initialUsedTokens: 333_600 },
  member("qwen3.7-max-2026-06-08", "text", "A", OCT_08, 20),
  member("qwen3.7-max-2026-05-20", "text", "A", OCT_08, 30),
  member("qwen3.7-max-2026-05-17", "text", "A", OCT_08, 40),
  member("qwen3.7-max", "text", "A", OCT_08, 50),
  member("qwen3-max-2026-01-23", "text", "A", OCT_08, 60),
  member("qwen3.7-plus-2026-05-26", "text", "A", OCT_08, 70),
  member("qwen3.7-plus", "text", "A", OCT_08, 80),
  member("deepseek-v4-pro", "text", "A", OCT_08, 90),
  member("deepseek-v3.2", "text", "A", OCT_08, 100),
  member("glm-5.2", "text", "A", OCT_08, 110),
  member("glm-5.1", "text", "A", OCT_08, 120),
  member("glm-5", "text", "A", OCT_08, 130),
  member("kimi-k2.6", "text", "A", OCT_08, 140),
  member("kimi-k2.5", "text", "A", OCT_08, 150),
  member("MiniMax-M2.5", "text", "A", OCT_08, 160),
  member("qwen3.6-plus-2026-04-02", "text", "A", OCT_08, 170),
  member("qwen3.5-plus-2026-04-20", "text", "A", OCT_08, 180),
  member("qwen3-235b-a22b-instruct-2507", "text", "A", OCT_08, 190),
  member("qwen3-next-80b-a3b-instruct", "text", "A", OCT_08, 200),
  member("qwen3.7-flash", "text", "B", "2026-10-23T23:59:59+08:00", 210),
  member("qwen3.7-flash-2026-07-15", "text", "B", "2026-10-23T23:59:59+08:00", 220),
  member("deepseek-v4-flash-0731", "text", "B", "2026-10-31T23:59:59+08:00", 230),
  member("qwen3.8-max", "text", "A", "2026-11-01T23:59:59+08:00", 240),
  member("deepseek-v4-pro-0813", "text", "A", "2026-11-13T23:59:59+08:00", 250),
  member("kimi-k3", "text", "A", "2026-11-18T23:59:59+08:00", 260),
  member("glm-5.3", "text", "A", "2026-11-23T23:59:59+08:00", 270),
  member("qwen3.8-flash", "text", "B", "2026-11-25T23:59:59+08:00", 280),
  member("qwen3.8-max-0902", "text", "A", "2026-12-01T23:59:59+08:00", 290),
];

export const QIANWEN_FREE_POOL_PRESET = Object.freeze<QianwenPresetMember[]>(
  members.map((item) => Object.freeze(item)),
);
