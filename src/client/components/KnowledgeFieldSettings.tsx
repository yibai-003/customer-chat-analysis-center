import { useEffect, useMemo, useState } from "react";
import type { AnalysisField, KnowledgeBase } from "../../shared/types";
import { knowledgeApi } from "../api/knowledge-api";
import { executionSetting } from "./execution-registry";

export function KnowledgeFieldSettings({
  field,
  fields,
  sectionId,
  onChange,
  onValidationChange,
}: {
  field: AnalysisField;
  fields: AnalysisField[];
  sectionId: string;
  onChange: (patch: Partial<AnalysisField>) => void;
  onValidationChange?: (fieldId: string, error: string) => void;
}) {
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectionNotice, setSelectionNotice] = useState("");
  const isKnowledgeMode = executionSetting(field.executionType).knowledgeMode;

  useEffect(() => {
    if (!isKnowledgeMode) return;
    let active = true;
    setBases([]);
    setLoading(true);
    setError("");
    knowledgeApi.listBases(sectionId)
      .then((items) => { if (active) setBases(items); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "知识库加载失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [isKnowledgeMode, sectionId]);

  const matchFields = fields.filter((candidate) => (
    candidate.executionType === "knowledge_match" && candidate.key !== field.key
  ));
  const selectedMatch = useMemo(
    () => matchFields.find((candidate) => candidate.key === field.matchFieldKey),
    [field.matchFieldKey, matchFields],
  );
  const selectedBaseId = field.executionType === "knowledge_match"
    ? field.knowledgeBaseId
    : selectedMatch?.knowledgeBaseId;
  const columns = bases.find((base) => base.id === selectedBaseId)?.columns ?? [];
  const columnsReady = Boolean(selectedBaseId) && !loading && bases.some((base) => base.id === selectedBaseId);
  const invalidKnowledgeColumn = field.executionType === "knowledge_extract"
    && columnsReady
    && Boolean(field.knowledgeColumn)
    && !columns.some((column) => column.name === field.knowledgeColumn);
  const configurationError = selectionNotice || (invalidKnowledgeColumn
    ? "当前匹配来源不包含原知识列，请重新选择"
    : "");

  useEffect(() => {
    if (onValidationChange) onValidationChange(field.id, configurationError);
  }, [configurationError, field.id, onValidationChange]);

  useEffect(() => {
    if (!invalidKnowledgeColumn || !field.knowledgeColumn) return;
    setSelectionNotice("当前匹配来源不包含原知识列，请重新选择");
    onChange({ knowledgeColumn: undefined });
  }, [field.knowledgeColumn, invalidKnowledgeColumn, onChange]);

  if (!isKnowledgeMode) return null;

  if (field.executionType === "knowledge_match") {
    return <div className="knowledge-field-settings">
      <label>知识库<select aria-label="知识库" disabled={loading || Boolean(error)} value={field.knowledgeBaseId ?? ""} onChange={(event) => onChange({ knowledgeBaseId: event.target.value || undefined })}>
        <option value="">请选择知识库</option>
        {bases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
      </select></label>
      <label>候选数<input aria-label="候选数" type="number" min={1} max={50} value={field.candidateLimit ?? 15} onChange={(event) => onChange({ candidateLimit: Number(event.target.value) || 1 })} /></label>
      <div className="wide export-setting"><span>导出设置</span><label className="inline-control"><input aria-label="导出到 Excel" type="checkbox" checked={field.exportEnabled !== false} onChange={(event) => onChange({ exportEnabled: event.target.checked })} />导出到 Excel</label></div>
      {loading && <div className="knowledge-field-status">正在加载知识库</div>}
      {error && <div className="form-error">知识库加载失败：{error}</div>}
    </div>;
  }

  return <div className="knowledge-field-settings">
    <label>匹配来源<select aria-label="匹配来源" disabled={loading || Boolean(error)} value={field.matchFieldKey ?? ""} onChange={(event) => {
      const nextMatchFieldKey = event.target.value || undefined;
      const nextMatch = matchFields.find((match) => match.key === nextMatchFieldKey);
      const nextColumns = bases.find((base) => base.id === nextMatch?.knowledgeBaseId)?.columns ?? [];
      const shouldClearColumn = Boolean(field.knowledgeColumn) && !nextColumns.some((column) => column.name === field.knowledgeColumn);
      setSelectionNotice(shouldClearColumn ? "当前匹配来源不包含原知识列，请重新选择" : "");
      onChange({
        matchFieldKey: nextMatchFieldKey,
        ...(shouldClearColumn ? { knowledgeColumn: undefined } : {}),
      });
    }}>
      <option value="">请选择匹配字段</option>
      {matchFields.map((match) => <option key={match.key} value={match.key}>{match.label} ({match.key})</option>)}
    </select></label>
    <label>知识列<select aria-label="知识列" value={field.knowledgeColumn ?? ""} onChange={(event) => {
      setSelectionNotice("");
      onChange({ knowledgeColumn: event.target.value || undefined });
    }} disabled={!selectedBaseId || loading || Boolean(error)}>
      <option value="">请选择知识列</option>
      {columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
    </select></label>
    <div className="wide export-setting"><span>导出设置</span><label className="inline-control"><input aria-label="导出到 Excel" type="checkbox" checked={field.exportEnabled !== false} onChange={(event) => onChange({ exportEnabled: event.target.checked })} />导出到 Excel</label></div>
    {loading && <div className="knowledge-field-status">正在加载知识库</div>}
    {error && <div className="form-error">知识库加载失败：{error}</div>}
    {configurationError && <div className="form-error">{configurationError}</div>}
  </div>;
}
