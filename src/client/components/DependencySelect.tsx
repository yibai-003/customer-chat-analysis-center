import type { AnalysisField } from "../../shared/types";

export function DependencySelect({ fields, currentKey, value, onChange, sourceFields = [] }: {
  fields: AnalysisField[];
  currentKey: string;
  value: string[];
  onChange: (value: string[]) => void;
  sourceFields?: string[];
}) {
  const options = fields.filter((field) => field.key !== currentKey);
  return <div className="dependency-select" aria-label="依赖字段">
    {[...sourceFields.map((field) => ({ id: `source-${field}`, key: field, label: field, group: "Excel 表头" })), ...options.map((field) => ({ id: field.id, key: field.key, label: field.label, group: "AI 字段" }))].length
      ? [...sourceFields.map((field) => ({ id: `source-${field}`, key: field, label: field, group: "Excel 表头" })), ...options.map((field) => ({ id: field.id, key: field.key, label: field.label, group: "AI 字段" }))].map((field) => <label key={field.id}>
        <input type="checkbox" checked={value.includes(field.key)} onChange={(event) => onChange(event.target.checked ? [...value, field.key] : value.filter((key) => key !== field.key))} />
        {field.label} <small>{field.group}</small>
      </label>)
      : <span className="muted">请先配置 Excel 表头字段</span>}
  </div>;
}
