import { useState } from "react";
import type { AnalysisField, AnalysisFieldType } from "../../shared/types";
import { DependencySelect } from "./DependencySelect";
import { PromptEditor } from "./PromptEditor";
import { KnowledgeFieldSettings, executionTypeLabel } from "./KnowledgeFieldSettings";

export function FieldConfigEditor({ fields, onChange, onAdd, onRemove, sourceFields = [], sectionId, onValidationChange }: {
  fields: AnalysisField[];
  onChange: (index: number, patch: Partial<AnalysisField>) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  sourceFields?: string[];
  sectionId?: string;
  onValidationChange?: (fieldId: string, error: string) => void;
}) {
  const [expandedDependencies, setExpandedDependencies] = useState<Record<string, boolean>>({});
  const availableSourceFields = sourceFields.filter((sourceField) => !fields.some((field) => field.outputColumn === sourceField));
  const effectiveSectionId = sectionId ?? fields[0]?.sectionId;
  const changeExecutionType = (index: number, field: AnalysisField, executionType: AnalysisField["executionType"]) => {
    if (executionType === "knowledge_match") {
      onChange(index, { executionType, exportEnabled: false, outputColumn: "" });
    } else if (executionType === "knowledge_extract") {
      onChange(index, { executionType, exportEnabled: field.exportEnabled ?? true });
    } else {
      onChange(index, { executionType: "ai", exportEnabled: true });
    }
  };
  return <div className="field-config-editor">
    <div className="schema-toolbar"><strong>字段解析链</strong><button onClick={onAdd} disabled={!availableSourceFields.length}>＋ 选择解析字段</button></div>
    {fields.map((field, index) => <div className="field-editor" key={field.id}>
      <div className="field-editor-head"><b>{String(index + 1).padStart(2, "0")}</b><strong>{field.label || "未命名字段"}</strong><button className="danger-text" onClick={() => onRemove(index)}>删除</button></div>
      <div className="field-editor-grid">
        <label>解析方式<div className="execution-type-switch" role="group" aria-label="解析方式">
          {[
            ["ai", "AI 解析"],
            ["knowledge_match", "知识库匹配"],
            ["knowledge_extract", "知识结果提取"],
          ].map(([value, label]) => <button type="button" key={value} aria-pressed={(field.executionType ?? "ai") === value} className={(field.executionType ?? "ai") === value ? "active" : ""} onClick={() => changeExecutionType(index, field, value as AnalysisField["executionType"])}>{label}</button>)}
        </div></label>
        {field.executionType !== "knowledge_match" && <label>目标 Excel 字段<select aria-label="目标 Excel 字段" value={field.outputColumn ?? ""} onChange={(event) => {
          const target = event.target.value;
          onChange(index, { label: target || field.label, key: target || field.key, outputColumn: target });
        }}><option value="">请选择表头字段</option>{sourceFields.map((sourceField) => <option key={sourceField} value={sourceField}>{sourceField}</option>)}</select></label>}
        <label>字段名称<input aria-label="字段名称" value={field.label} onChange={(event) => onChange(index, { label: event.target.value })} /></label>
        <label>字段 Key<input aria-label="字段 Key" value={field.key} onChange={(event) => onChange(index, { key: event.target.value })} /></label>
        <label>字段类型<select aria-label="字段类型" value={field.type} onChange={(event) => onChange(index, { type: event.target.value as AnalysisFieldType })}><option value="string">文本</option><option value="number">数字</option><option value="boolean">布尔</option><option value="object">结构化对象</option></select></label>
        {field.executionType !== "knowledge_match" && <label>Excel 输出列<input aria-label="Excel 输出列" value={field.outputColumn ?? ""} readOnly /> </label>}
      </div>
      <div className="field-mode-label">当前方式：{executionTypeLabel(field.executionType)}</div>
      {field.executionType !== "knowledge_extract" && <PromptEditor value={field.prompt} onChange={(prompt) => onChange(index, { prompt })} />}
      {field.executionType !== "knowledge_extract" && <label>可选值<input aria-label="可选值" value={(field.options ?? []).join(", ")} placeholder="价格问题, 产品问题" onChange={(event) => onChange(index, { options: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></label>}
      {field.executionType !== "knowledge_extract" && <div className="field-flags">
        {field.executionType === "ai" && <label><input aria-label="图片解析" type="checkbox" checked={field.imageEnabled} onChange={(event) => onChange(index, { imageEnabled: event.target.checked })} />图片解析</label>}
        <label><input aria-label="必填" type="checkbox" checked={field.required} onChange={(event) => onChange(index, { required: event.target.checked })} />必填</label>
        <label><input aria-label="导出到 Excel" type="checkbox" checked={field.exportEnabled !== false} onChange={(event) => onChange(index, { exportEnabled: event.target.checked })} />导出到 Excel</label>
      </div>}
      {effectiveSectionId && <KnowledgeFieldSettings
        field={field}
        fields={fields}
        sectionId={effectiveSectionId}
        onChange={(patch) => onChange(index, patch)}
        onValidationChange={onValidationChange}
      />}
      <div className="dependency-block">
        <div className="dependency-head">
          <span className="field-label">依赖字段</span>
          <button type="button" className="dependency-toggle" aria-expanded={Boolean(expandedDependencies[field.id])} onClick={() => setExpandedDependencies((current) => ({ ...current, [field.id]: !current[field.id] }))}>
            {expandedDependencies[field.id] ? "隐藏选择" : "显示选择"}{field.dependsOn.length ? ` · 已选 ${field.dependsOn.length}` : ""}
          </button>
        </div>
        {expandedDependencies[field.id] && <DependencySelect fields={fields} sourceFields={sourceFields} currentKey={field.key} value={field.dependsOn} onChange={(dependsOn) => onChange(index, { dependsOn })} />}
      </div>
    </div>)}
    {!fields.length && <div className="no-results">当前板块还没有解析字段</div>}
  </div>;
}
