import {
  DEFAULT_EXECUTION_TYPE,
  type AnalysisExecutionType,
  type AnalysisField,
} from "../../shared/types";

export interface ExecutionTypeSetting {
  type: AnalysisExecutionType;
  label: string;
  selectable: boolean;
  knowledgeMode: boolean;
  showTargetColumn: boolean;
  showPrompt: boolean;
  showOptions: boolean;
  showFlags: boolean;
  showImageToggle: boolean;
  selectionPatch?: (field: AnalysisField) => Partial<AnalysisField>;
}

const knowledgeSyncOff = (field: AnalysisField) =>
  field.knowledgeSyncEnabled ? { knowledgeSyncEnabled: false } : {};

const derivedDefaults = {
  selectable: false,
  knowledgeMode: false,
  showTargetColumn: true,
  showPrompt: true,
  showOptions: true,
  showFlags: true,
  showImageToggle: false,
} as const;

const receptionInternalDefaults = {
  selectable: false,
  knowledgeMode: false,
  showTargetColumn: false,
  showPrompt: true,
  showOptions: false,
  showFlags: true,
  showImageToggle: false,
} as const;

export const EXECUTION_TYPE_SETTINGS: Record<AnalysisExecutionType, ExecutionTypeSetting> = {
  ai: {
    type: "ai",
    label: "AI 解析",
    selectable: true,
    knowledgeMode: false,
    showTargetColumn: true,
    showPrompt: true,
    showOptions: true,
    showFlags: true,
    showImageToggle: true,
    selectionPatch: () => ({ exportEnabled: true }),
  },
  knowledge_match: {
    type: "knowledge_match",
    label: "知识库匹配",
    selectable: true,
    knowledgeMode: true,
    showTargetColumn: false,
    showPrompt: true,
    showOptions: true,
    showFlags: true,
    showImageToggle: false,
    selectionPatch: (field) => ({ exportEnabled: false, outputColumn: "", ...knowledgeSyncOff(field) }),
  },
  knowledge_extract: {
    type: "knowledge_extract",
    label: "知识结果提取",
    selectable: true,
    knowledgeMode: true,
    showTargetColumn: true,
    showPrompt: false,
    showOptions: false,
    showFlags: false,
    showImageToggle: false,
    selectionPatch: (field) => ({ exportEnabled: field.exportEnabled ?? true, ...knowledgeSyncOff(field) }),
  },
  lost_deal_attribution: { type: "lost_deal_attribution", label: "未成交归因", ...derivedDefaults },
  lost_deal_derive: { type: "lost_deal_derive", label: "未成交字段派生", ...derivedDefaults },
  lost_deal_script: { type: "lost_deal_script", label: "话术建议", ...derivedDefaults },
  reception_screenshot_facts: { type: "reception_screenshot_facts", label: "接待截图事实抽取", ...receptionInternalDefaults },
  reception_quality_analysis: { type: "reception_quality_analysis", label: "统一质检分析", ...receptionInternalDefaults },
  reception_quality_derive: { type: "reception_quality_derive", label: "质检字段派生", ...derivedDefaults },
};

export function executionSetting(type: AnalysisExecutionType | undefined): ExecutionTypeSetting {
  return EXECUTION_TYPE_SETTINGS[type ?? DEFAULT_EXECUTION_TYPE];
}

export function executionTypeLabel(type: AnalysisExecutionType | undefined): string {
  return executionSetting(type).label;
}

export const SELECTABLE_EXECUTION_SETTINGS = Object.values(EXECUTION_TYPE_SETTINGS)
  .filter((setting) => setting.selectable);
