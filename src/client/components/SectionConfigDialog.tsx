import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisField, AnalysisSection } from "../../shared/types";
import { Modal } from "./Modal";
import { FieldConfigEditor } from "./FieldConfigEditor";

const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(body.error || "请求失败");
  return body.data as T;
};

const newField = (sectionId: string, fields: AnalysisField[], sourceFields: string[]): AnalysisField => {
  const usedFields = new Set(fields.map((field) => field.outputColumn));
  const target = sourceFields.find((sourceField) => !usedFields.has(sourceField)) ?? "";
  const key = target || `field_${fields.length + 1}`;
  return {
  id: `new-${crypto.randomUUID()}`, sectionId, key, label: target || "待选择字段", type: "string",
  prompt: "请根据聊天截图和辅助字段解析该字段。", required: false, imageEnabled: false,
  dependsOn: [], sortOrder: 0, isEnabled: true, options: [], outputColumn: target,
  executionType: "ai", exportEnabled: true,
  };
};

export function SectionConfigDialog({ sections, close, saved }: { sections: AnalysisSection[]; close: () => void; saved: () => void }) {
  const childSections = sections.filter((section) => section.parentId);
  const [section, setSection] = useState<AnalysisSection | undefined>(childSections[0]);
  const [fields, setFields] = useState<AnalysisField[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const requestId = useRef(0);
  const sectionId = section?.id;

  useEffect(() => {
    if (!sectionId) return;
    const currentRequestId = ++requestId.current;
    const controller = new AbortController();
    setFields([]);
    setFieldErrors({});
    setError("");
    setLoading(true);
    api<AnalysisField[]>(`/api/sections/${sectionId}/fields`, { signal: controller.signal })
      .then((items) => {
        if (currentRequestId === requestId.current) setFields(items);
      })
      .catch((reason) => {
        if (controller.signal.aborted || currentRequestId !== requestId.current) return;
        setError(reason instanceof Error ? reason.message : "加载字段失败");
      })
      .finally(() => {
        if (currentRequestId === requestId.current) setLoading(false);
      });
    return () => controller.abort();
  }, [sectionId]);

  const updateFieldError = useCallback((fieldId: string, validationError: string) => {
    setFieldErrors((current) => {
      if (validationError) {
        if (current[fieldId] === validationError) return current;
        return { ...current, [fieldId]: validationError };
      }
      if (!(fieldId in current)) return current;
      const next = { ...current };
      delete next[fieldId];
      return next;
    });
  }, []);
  if (!section) return null;
  const updateField = (index: number, patch: Partial<AnalysisField>) => {
    setFields((current) => current.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field));
    if (patch.executionType) {
      setFieldErrors((current) => {
        const fieldId = fields[index]?.id;
        if (!fieldId || !(fieldId in current)) return current;
        const next = { ...current };
        delete next[fieldId];
        return next;
      });
    }
  };
  const save = async () => {
    setError("");
    try {
      const validationError = Object.values(fieldErrors).find(Boolean);
      if (validationError) throw new Error(validationError);
      const usedKeys = new Set<string>();
      const fieldsToSave = fields.map((field, index) => {
        let key = field.key.trim();
        if (field.id.startsWith("new-") && (!key || usedKeys.has(key))) {
          let suffix = index + 1;
          key = `field_${suffix}`;
          while (usedKeys.has(key)) key = `field_${++suffix}`;
        }
        usedKeys.add(key);
        return key === field.key ? field : { ...field, key };
      });
      const duplicateKeys = fieldsToSave
        .map((field) => field.key)
        .filter((key, index, keys) => key && keys.indexOf(key) !== index);
      if (duplicateKeys.length) {
        throw new Error(`字段 Key 重复：${[...new Set(duplicateKeys)].join("、")}，请修改后再保存`);
      }
      for (const id of removed) await api(`/api/fields/${id}`, { method: "DELETE" });
      for (const [index, field] of fieldsToSave.entries()) {
        const payload = { ...field, sectionId: section.id, sortOrder: index };
        const method = field.id.startsWith("new-") ? "POST" : "PATCH";
        const url = method === "POST" ? `/api/sections/${section.id}/fields` : `/api/fields/${field.id}`;
        await api(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      }
      await api(`/api/sections/${section.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...section }) });
      saved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
  };
  return <Modal title="解析字段配置" subtitle="每个字段拥有独立提示词、图片策略和依赖关系" close={close}>
    <div className="section-editor">
      <div className="section-pick">{childSections.map((item) => <button className={item.id === section.id ? "active" : ""} key={item.id} onClick={() => setSection(item)}>{item.name}</button>)}</div>
      <div className="prompt-editor">
        <label>板块说明<textarea rows={3} value={section.prompt} onChange={(event) => setSection({ ...section, prompt: event.target.value })} /></label>
        <label>Excel 表头字段<textarea rows={2} value={(section.sourceFields ?? []).join(", ")} placeholder="店铺名称, 售后问题类型, 截图内容" onChange={(event) => setSection({ ...section, sourceFields: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></label>
        {loading ? <div className="no-results">正在加载字段...</div> : <FieldConfigEditor
          fields={fields}
          sectionId={section.id}
          onValidationChange={updateFieldError}
          sourceFields={section.sourceFields ?? []}
          onChange={updateField}
          onAdd={() => setFields((current) => [...current, newField(section.id, current, section.sourceFields ?? [])])}
          onRemove={(index) => {
            const target = fields[index];
            setFieldErrors((current) => {
              if (!(target.id in current)) return current;
              const next = { ...current };
              delete next[target.id];
              return next;
            });
            if (!target.id.startsWith("new-")) setRemoved((current) => [...current, target.id]);
            setFields((current) => current.filter((_, fieldIndex) => fieldIndex !== index));
          }}
        />}
      </div>
    </div>
    {error && <div className="form-error">{error}</div>}
    <div className="modal-actions"><button className="button light" onClick={close}>取消</button><button className="button dark" disabled={Boolean(Object.values(fieldErrors).find(Boolean))} onClick={save}>保存字段配置 →</button></div>
  </Modal>;
}
