import { useState } from "react";
import type { AnalysisField, AnalysisFieldType } from "../../shared/types";
import { HOT_TOPIC_PROMPT, isHotTopicField } from "../../shared/hot-topic";
import { DependencySelect } from "./DependencySelect";
import { PromptEditor } from "./PromptEditor";
import { KnowledgeFieldSettings } from "./KnowledgeFieldSettings";
import { SELECTABLE_EXECUTION_SETTINGS, executionSetting } from "./execution-registry";

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
  const isLostDealAttribution = (field: AnalysisField) => field.sectionId === "lost-deal"
    && field.key === "未成交归因" && field.executionType === "lost_deal_attribution";
  const changeExecutionType = (index: number, field: AnalysisField, executionType: AnalysisField["executionType"]) => {
    const setting = executionSetting(executionType);
    onChange(index, { executionType: setting.type, ...(setting.selectionPatch?.(field) ?? {}) });
  };
  return <div className="field-config-editor">
    <div className="schema-toolbar"><strong>字段解析链</strong><button onClick={onAdd} disabled={!availableSourceFields.length}>＋ 选择解析字段</button></div>
    {fields.map((field, index) => {
      const setting = executionSetting(field.executionType);
      return <div className="field-editor" key={field.id}>
        <div className="field-editor-head"><b>{String(index + 1).padStart(2, "0")}</b><strong>{field.label || "未命名字段"}</strong><button className="danger-text" onClick={() => onRemove(index)}>删除</button></div>
        <div className="field-editor-grid">
          <label>解析方式<div className="execution-type-switch" role="group" aria-label="解析方式">
            {SELECTABLE_EXECUTION_SETTINGS.map((option) => <button type="button" key={option.type} aria-pressed={setting.type === option.type} className={setting.type === option.type ? "active" : ""} onClick={() => changeExecutionType(index, field, option.type)}>{option.label}</button>)}
          </div></label>
          {setting.showTargetColumn && <label>目标 Excel 字段<select aria-label="目标 Excel 字段" value={field.outputColumn ?? ""} onChange={(event) => {
            const target = event.target.value;
            onChange(index, { label: target || field.label, key: target || field.key, outputColumn: target });
          }}><option value="">请选择表头字段</option>{sourceFields.map((sourceField) => <option key={sourceField} value={sourceField}>{sourceField}</option>)}</select></label>}
          <label>字段名称<input aria-label="字段名称" value={field.label} onChange={(event) => onChange(index, { label: event.target.value })} /></label>
          <label>字段 Key<input aria-label="字段 Key" value={field.key} onChange={(event) => onChange(index, { key: event.target.value })} /></label>
          <label>字段类型<select aria-label="字段类型" value={field.type} onChange={(event) => onChange(index, { type: event.target.value as AnalysisFieldType })}><option value="string">文本</option><option value="number">数字</option><option value="boolean">布尔</option><option value="object">结构化对象</option></select></label>
          {setting.showTargetColumn && <label>Excel 输出列<input aria-label="Excel 输出列" value={field.outputColumn ?? ""} readOnly /> </label>}
        </div>
        <div className="field-mode-label">当前方式：{setting.label}</div>
        {isHotTopicField(field) && <div className="hot-topic-capture">
          <div><strong>高频问题知识沉淀</strong><p>优先匹配本板块已启用的问题库；无匹配时自动补充到「热点话题问题库」。</p></div>
          <label className="hot-topic-capture-toggle"><input aria-label="启用高频问题知识沉淀" type="checkbox" checked={Boolean(field.knowledgeSyncEnabled)} onChange={(event) => onChange(index, { knowledgeSyncEnabled: event.target.checked })} />启用知识沉淀</label>
          {field.knowledgeSyncEnabled && <div className="hot-topic-capture-options">
            <label>每条记录最多提炼<select aria-label="每条记录最多提炼问题数" value={field.knowledgeCaptureLimit ?? 2} onChange={(event) => onChange(index, { knowledgeCaptureLimit: Number(event.target.value) as 1 | 2 })}><option value={1}>1 个问题词条</option><option value={2}>2 个问题词条</option></select></label>
            <p>已有词条与新增词条合计不超过上限；没有明确问题时留空。问题库需有一个结果列。同一记录重试不重复计数，语义不确定时标记复核。</p>
            <button type="button" className="hot-topic-prompt-button" onClick={() => onChange(index, { prompt: HOT_TOPIC_PROMPT, type: "string", required: false, imageEnabled: false, options: [] })}>使用问题提炼提示词</button>
          </div>}
        </div>}
        {isLostDealAttribution(field) && <div className="hot-topic-capture">
          <div><strong>未成交原因知识沉淀</strong><p>将证据充分的标准客户原因和客服原因关联到当前记录，并在对应知识库累计频次。</p></div>
          <label className="hot-topic-capture-toggle"><input aria-label="启用未成交原因知识沉淀" type="checkbox" checked={Boolean(field.knowledgeSyncEnabled)} onChange={(event) => onChange(index, { knowledgeSyncEnabled: event.target.checked })} />启用知识沉淀</label>
          <div className="hot-topic-capture-options">
            <p>知识库外分类和证据不足的归因只进入人工复核，不会自动扩充标准原因库；同一记录重试不会重复计数。</p>
          </div>
        </div>}
        {setting.showPrompt && <PromptEditor value={field.prompt} onChange={(prompt) => onChange(index, { prompt })} />}
        {setting.showOptions && <label>可选值<input aria-label="可选值" value={(field.options ?? []).join(", ")} placeholder="价格问题, 产品问题" onChange={(event) => onChange(index, { options: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></label>}
        {setting.showFlags && <div className="field-flags">
          {setting.showImageToggle && <label><input aria-label="图片解析" type="checkbox" checked={field.imageEnabled} onChange={(event) => onChange(index, { imageEnabled: event.target.checked })} />图片解析</label>}
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
      </div>;
    })}
    {!fields.length && <div className="no-results">当前板块还没有解析字段</div>}
  </div>;
}
