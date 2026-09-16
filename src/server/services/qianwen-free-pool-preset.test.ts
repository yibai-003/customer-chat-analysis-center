import { describe, expect, it } from "vitest";
import { QIANWEN_FREE_POOL_PRESET, QIANWEN_FREE_POOL_PRESET_VERSION } from "./qianwen-free-pool-preset";

const OCT_08 = "2026-10-08T23:59:59+08:00";

const approvedMembers = [
  ["qwen3-vl-plus", "vision", "A", false, "general", OCT_08, 10, 803_700],
  ["qwen3-vl-plus-2025-12-19", "vision", "A", false, "general", OCT_08, 20],
  ["qwen3-vl-plus-2025-09-23", "vision", "A", false, "general", OCT_08, 30],
  ["qwen3-vl-235b-a22b-instruct", "vision", "A", false, "general", OCT_08, 40],
  ["qwen3-vl-235b-a22b-thinking", "vision", "A", true, "general", OCT_08, 50],
  ["qwen3-vl-32b-instruct", "vision", "A", false, "general", OCT_08, 60],
  ["qwen3-vl-32b-thinking", "vision", "A", true, "general", OCT_08, 70],
  ["qwen3-vl-30b-a3b-instruct", "vision", "A", false, "general", OCT_08, 80],
  ["qwen3-vl-30b-a3b-thinking", "vision", "A", true, "general", OCT_08, 90],
  ["qwen3.5-omni-plus", "vision", "A", false, "general", OCT_08, 100],
  ["qwen3.5-omni-plus-2026-03-15", "vision", "A", false, "general", OCT_08, 110],
  ["qwen-vl-max-2025-08-13", "vision", "A", false, "general", OCT_08, 120],
  ["qwen-vl-max-2025-04-08", "vision", "A", false, "general", OCT_08, 130],
  ["qwen3-vl-flash", "vision", "B", false, "general", OCT_08, 140],
  ["qwen3-vl-flash-2026-01-22", "vision", "B", false, "general", OCT_08, 150],
  ["qwen3-vl-flash-2025-10-15", "vision", "B", false, "general", OCT_08, 160],
  ["qwen3.5-omni-flash", "vision", "B", false, "general", OCT_08, 170],
  ["qwen3.5-omni-flash-2026-03-15", "vision", "B", false, "general", OCT_08, 180],
  ["qwen3-vl-8b-instruct", "vision", "C", false, "general", OCT_08, 190],
  ["qwen3-vl-8b-thinking", "vision", "C", true, "general", OCT_08, 200],
  ["qwen3.5-ocr", "vision", "C", false, "ocr", OCT_08, 210],
  ["qwen-vl-ocr", "vision", "C", false, "ocr", OCT_08, 220],
  ["qwen-plus", "text", "A", false, "general", OCT_08, 10, 333_600],
  ["qwen3.7-max-2026-06-08", "text", "A", false, "general", OCT_08, 20],
  ["qwen3.7-max-2026-05-20", "text", "A", false, "general", OCT_08, 30],
  ["qwen3.7-max-2026-05-17", "text", "A", false, "general", OCT_08, 40],
  ["qwen3.7-max", "text", "A", false, "general", OCT_08, 50],
  ["qwen3-max-2026-01-23", "text", "A", false, "general", OCT_08, 60],
  ["qwen3.7-plus-2026-05-26", "text", "A", false, "general", OCT_08, 70],
  ["qwen3.7-plus", "text", "A", false, "general", OCT_08, 80],
  ["deepseek-v4-pro", "text", "A", false, "general", OCT_08, 90],
  ["deepseek-v3.2", "text", "A", false, "general", OCT_08, 100],
  ["glm-5.2", "text", "A", false, "general", OCT_08, 110],
  ["glm-5.1", "text", "A", false, "general", OCT_08, 120],
  ["glm-5", "text", "A", false, "general", OCT_08, 130],
  ["kimi-k2.6", "text", "A", false, "general", OCT_08, 140],
  ["kimi-k2.5", "text", "A", false, "general", OCT_08, 150],
  ["MiniMax-M2.5", "text", "A", false, "general", OCT_08, 160],
  ["qwen3.6-plus-2026-04-02", "text", "A", false, "general", OCT_08, 170],
  ["qwen3.5-plus-2026-04-20", "text", "A", false, "general", OCT_08, 180],
  ["qwen3-235b-a22b-instruct-2507", "text", "A", false, "general", OCT_08, 190],
  ["qwen3-next-80b-a3b-instruct", "text", "A", false, "general", OCT_08, 200],
  ["qwen3.7-flash", "text", "B", false, "general", "2026-10-23T23:59:59+08:00", 210],
  ["qwen3.7-flash-2026-07-15", "text", "B", false, "general", "2026-10-23T23:59:59+08:00", 220],
  ["deepseek-v4-flash-0731", "text", "B", false, "general", "2026-10-31T23:59:59+08:00", 230],
  ["qwen3.8-max", "text", "A", false, "general", "2026-11-01T23:59:59+08:00", 240],
  ["deepseek-v4-pro-0813", "text", "A", false, "general", "2026-11-13T23:59:59+08:00", 250],
  ["kimi-k3", "text", "A", false, "general", "2026-11-18T23:59:59+08:00", 260],
  ["glm-5.3", "text", "A", false, "general", "2026-11-23T23:59:59+08:00", 270],
  ["qwen3.8-flash", "text", "B", false, "general", "2026-11-25T23:59:59+08:00", 280],
  ["qwen3.8-max-0902", "text", "A", false, "general", "2026-12-01T23:59:59+08:00", 290],
] as const;

describe("Qianwen free-pool preset", () => {
  it("contains the complete approved version 1 model list with exact metadata", () => {
    expect(QIANWEN_FREE_POOL_PRESET_VERSION).toBe(1);
    expect(QIANWEN_FREE_POOL_PRESET.map((member) => [
      member.model,
      member.purpose,
      member.qualityTier,
      member.thinkingMode,
      member.memberType,
      member.quotaExpiresAt,
      member.priority,
      ...(member.initialUsedTokens === undefined ? [] : [member.initialUsedTokens]),
    ])).toEqual(approvedMembers);
    expect(QIANWEN_FREE_POOL_PRESET.every((member) => member.quotaTotalTokens === 1_000_000)).toBe(true);
  });

  it("is immutable at the collection and member level", () => {
    expect(Object.isFrozen(QIANWEN_FREE_POOL_PRESET)).toBe(true);
    expect(QIANWEN_FREE_POOL_PRESET.every(Object.isFrozen)).toBe(true);
  });
});
