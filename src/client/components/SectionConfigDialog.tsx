import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AnalysisField,
  AnalysisSection,
  GenericImportContract,
  SectionConfigVersion,
} from "../../shared/types";
import { Modal } from "./Modal";
import { FieldConfigEditor } from "./FieldConfigEditor";
import { executionTypeLabel } from "./execution-registry";

const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(body.error || "请求失败");
  return body.data as T;
};

type ConfigMode = "loading" | "version" | "legacy";

function uniqueValues(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseList(value: string) {
  return uniqueValues(value.split(","));
}

function moveField(fields: AnalysisField[], fromIndex: number, toIndex: number): AnalysisField[] {
  if (toIndex < 0 || toIndex >= fields.length || fromIndex === toIndex) return fields;
  const next = [...fields];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function newField(sectionId: string, fields: AnalysisField[]): AnalysisField {
  const usedKeys = new Set(fields.map((field) => field.key));
  let suffix = fields.length + 1;
  let key = `field_${suffix}`;
  while (usedKeys.has(key)) key = `field_${++suffix}`;
  const label = `新字段 ${suffix}`;
  return {
    id: `new-${crypto.randomUUID()}`,
    sectionId,
    key,
    label,
    type: "string",
    prompt: "请根据聊天截图和辅助字段解析该字段。",
    required: false,
    imageEnabled: false,
    dependsOn: [],
    sortOrder: fields.length,
    isEnabled: true,
    options: [],
    outputColumn: label,
    executionType: "ai",
    exportEnabled: true,
    candidateLimit: 15,
    knowledgeSyncEnabled: false,
    knowledgeCaptureLimit: 2,
  };
}

function isSectionVersionList(value: unknown): value is SectionConfigVersion[] {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<SectionConfigVersion>;
    return typeof candidate.id === "string"
      && typeof candidate.status === "string"
      && Array.isArray(candidate.fieldsSnapshot)
      && Boolean(candidate.sectionSnapshot);
  });
}

function genericContractForVersion(version: SectionConfigVersion): GenericImportContract {
  const sourceFields = version.sectionSnapshot.sourceFields ?? [];
  const rules = version.businessRules as {
    kind?: unknown;
    importContract?: Partial<GenericImportContract>;
  };
  if (rules.kind === "generic" && rules.importContract) {
    const contract = rules.importContract;
    const imageColumn = contract.imageColumn?.trim() || "聊天截图";
    return {
      imageColumn,
      imageColumnRequired: contract.imageColumnRequired ?? sourceFields.includes(imageColumn),
      requiredColumns: uniqueValues(contract.requiredColumns ?? []),
      optionalColumns: uniqueValues(contract.optionalColumns ?? []),
    };
  }
  const imageColumn = sourceFields.find((field) => field === "聊天截图")
    ?? sourceFields.find((field) => field.includes("(chat_screenshot)"))
    ?? "聊天截图";
  return {
    imageColumn,
    requiredColumns: sourceFields.filter((field) => field !== imageColumn),
    optionalColumns: [],
  };
}

function fieldTypeLabel(type: AnalysisField["type"]) {
  return {
    string: "文本",
    number: "数字",
    boolean: "布尔",
    object: "结构化对象",
  }[type];
}

function PublishedVersionPreview({ version }: { version: SectionConfigVersion }) {
  const isGeneric = version.sectionId !== "reception";
  const contract = genericContractForVersion(version);
  const summary = isGeneric
    ? [
      { label: "聊天截图表头", value: contract.imageColumn },
      { label: "必需辅助表头", value: contract.requiredColumns.join("、") || "无" },
      { label: "可选辅助表头", value: contract.optionalColumns.join("、") || "无" },
    ]
    : [{
      label: "Excel 输入表头",
      value: version.sectionSnapshot.sourceFields?.join("、") || "未配置",
    }];

  return <div className="published-config">
    <div className="published-config-head">
      <strong>V{version.versionNumber} · 当前启用</strong>
      <span>已发布 · {version.fieldsSnapshot.length} 个字段</span>
    </div>
    <div className="published-config-summary">
      <div>
        <span>板块说明</span>
        <p>{version.sectionSnapshot.prompt || "未配置"}</p>
      </div>
      {summary.map((item) => <div key={item.label}>
        <span>{item.label}</span>
        <p>{item.value}</p>
      </div>)}
    </div>
    <div className="published-config-fields">
      <div className="published-config-fields-title"><strong>字段解析链</strong><span>{version.fieldsSnapshot.length} 项</span></div>
      {version.fieldsSnapshot.map((field, index) => <article className="published-config-field" key={field.id}>
        <header>
          <b>{String(index + 1).padStart(2, "0")}</b>
          <strong>{field.label || "未命名字段"}</strong>
          <code>{field.key}</code>
        </header>
        <div className="published-config-field-meta">
          {fieldTypeLabel(field.type)} · {executionTypeLabel(field.executionType)} · {field.isEnabled ? "已启用" : "已停用"}
          {field.required ? " · 必填" : ""}
          {field.imageEnabled ? " · 使用截图" : ""}
          {field.exportEnabled === false ? " · 不导出" : field.outputColumn ? ` · 导出列：${field.outputColumn}` : ""}
        </div>
        {field.prompt && <p>{field.prompt}</p>}
      </article>)}
    </div>
  </div>;
}

export function SectionConfigDialog({
  sections,
  close,
  saved,
}: {
  sections: AnalysisSection[];
  close: () => void;
  saved: () => void;
}) {
  const childSections = sections.filter((section) => section.parentId);
  const [section, setSection] = useState<AnalysisSection | undefined>(childSections[0]);
  const [fields, setFields] = useState<AnalysisField[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<ConfigMode>("loading");
  const [draftVersion, setDraftVersion] = useState<SectionConfigVersion | null>(null);
  const [publishedVersion, setPublishedVersion] = useState<SectionConfigVersion | null>(null);
  const requestId = useRef(0);
  const sectionId = section?.id;

  useEffect(() => {
    if (!sectionId) return;
    const currentRequestId = ++requestId.current;
    const controller = new AbortController();
    setFields([]);
    setRemoved([]);
    setFieldErrors({});
    setDraftVersion(null);
    setPublishedVersion(null);
    setError("");
    setLoading(true);
    setMode("loading");

    const load = async () => {
      try {
        const versions = await api<unknown>(`/api/sections/${sectionId}/versions`, { signal: controller.signal });
        if (currentRequestId !== requestId.current) return;
        if (isSectionVersionList(versions)) {
          setDraftVersion(versions.find((version) => version.status === "draft") ?? null);
          const publishedVersions = versions.filter((version) => version.status === "published");
          setPublishedVersion(
            publishedVersions.find((version) => version.isCurrent)
              ?? publishedVersions.toSorted((left, right) => right.versionNumber - left.versionNumber)[0]
              ?? null,
          );
          setMode("version");
          setLoading(false);
          return;
        }
      } catch {
        if (controller.signal.aborted || currentRequestId !== requestId.current) return;
      }

      try {
        const items = await api<AnalysisField[]>(`/api/sections/${sectionId}/fields`, { signal: controller.signal });
        if (currentRequestId === requestId.current) {
          setFields(items);
          setMode("legacy");
        }
      } catch (reason) {
        if (controller.signal.aborted || currentRequestId !== requestId.current) return;
        setError(reason instanceof Error ? reason.message : "加载字段失败");
      } finally {
        if (currentRequestId === requestId.current) setLoading(false);
      }
    };
    void load();
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

  const createDraft = async () => {
    if (!sectionId || loading) return;
    setLoading(true);
    setError("");
    try {
      const created = await api<SectionConfigVersion>(`/api/sections/${sectionId}/versions`, { method: "POST" });
      setDraftVersion(created);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建草稿失败");
    } finally {
      setLoading(false);
    }
  };

  if (!section) return null;
  if (mode === "version" && draftVersion) {
    return <VersionDraftEditor
      key={draftVersion.id}
      version={draftVersion}
      sections={childSections}
      selectSection={setSection}
      close={close}
      saved={saved}
    />;
  }
  if (mode === "version") {
    return <Modal
      title="解析字段配置"
      subtitle={publishedVersion
        ? `当前展示已发布配置 V${publishedVersion.versionNumber}；编辑请先创建草稿`
        : "当前板块尚无已发布配置，可创建初始草稿"}
      close={close}
    >
      <div className="section-editor">
        <div className="section-pick">
          {childSections.map((item) => <button
            className={item.id === section.id ? "active" : ""}
            key={item.id}
            disabled={loading}
            onClick={() => setSection(item)}
          >{item.name}</button>)}
        </div>
        {publishedVersion
          ? <PublishedVersionPreview version={publishedVersion} />
          : <div className="no-results">当前板块暂无已发布版本或草稿版本。</div>}
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button className="button light" onClick={close}>取消</button>
        <button className="button dark" disabled={loading} onClick={() => void createDraft()}>
          {loading ? "创建中..." : publishedVersion ? "基于当前版本创建草稿" : "创建配置草稿"}
        </button>
      </div>
    </Modal>;
  }

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
      await api(`/api/sections/${section.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...section }),
      });
      saved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    }
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
          allowInputSources
          onChange={updateField}
          onMove={(fromIndex, toIndex) => setFields((current) => moveField(current, fromIndex, toIndex))}
          onAdd={() => setFields((current) => [...current, newField(section.id, current)])}
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

function VersionDraftEditor({
  version,
  sections,
  selectSection,
  close,
  saved,
}: {
  version: SectionConfigVersion;
  sections: AnalysisSection[];
  selectSection: (section: AnalysisSection) => void;
  close: () => void;
  saved: () => void;
}) {
  const [section, setSection] = useState<AnalysisSection>(() => structuredClone(version.sectionSnapshot));
  const [fields, setFields] = useState<AnalysisField[]>(() => structuredClone(version.fieldsSnapshot));
  const [contract, setContract] = useState<GenericImportContract>(() => genericContractForVersion(version));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const isGeneric = version.sectionId !== "reception";

  const updateFieldError = useCallback((fieldId: string, validationError: string) => {
    setFieldErrors((current) => {
      if (validationError) return { ...current, [fieldId]: validationError };
      if (!(fieldId in current)) return current;
      const next = { ...current };
      delete next[fieldId];
      return next;
    });
  }, []);

  const updateContract = (patch: Partial<GenericImportContract>) => {
    setContract((current) => {
      const next = {
        ...current,
        ...patch,
        ...(patch.imageColumn !== undefined ? { imageColumnRequired: true } : {}),
        requiredColumns: uniqueValues(patch.requiredColumns ?? current.requiredColumns),
        optionalColumns: uniqueValues(patch.optionalColumns ?? current.optionalColumns),
      };
      setSection((currentSection) => ({
        ...currentSection,
        sourceFields: uniqueValues([next.imageColumn, ...next.requiredColumns, ...next.optionalColumns]),
      }));
      return next;
    });
  };

  const updateField = (index: number, patch: Partial<AnalysisField>) => {
    setFields((current) => current.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field));
  };

  const saveDraft = async () => {
    setError("");
    const validationError = Object.values(fieldErrors).find(Boolean);
    if (validationError) {
      setError(validationError);
      return;
    }
    const usedKeys = new Set<string>();
    const normalizedFields = fields.map((field, index) => {
      let key = field.key.trim();
      if (field.id.startsWith("new-") && (!key || usedKeys.has(key))) {
        let suffix = index + 1;
        key = `field_${suffix}`;
        while (usedKeys.has(key)) key = `field_${++suffix}`;
      }
      usedKeys.add(key);
      return {
        ...field,
        sectionId: version.sectionId,
        key,
        sortOrder: index,
      };
    });
    const duplicateKeys = normalizedFields
      .map((field) => field.key)
      .filter((key, index, keys) => key && keys.indexOf(key) !== index);
    if (duplicateKeys.length) {
      setError(`字段 Key 重复：${[...new Set(duplicateKeys)].join("、")}，请修改后再保存`);
      return;
    }

    setSaving(true);
    try {
      const currentRules = version.businessRules as Record<string, unknown>;
      const businessRules = isGeneric
        ? { ...currentRules, kind: "generic", importContract: contract }
        : currentRules;
      await api<SectionConfigVersion>(`/api/section-config-versions/${version.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sectionSnapshot: { ...section, id: version.sectionId },
          fieldsSnapshot: normalizedFields,
          businessRules,
        }),
      });
      saved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "草稿保存失败");
    } finally {
      setSaving(false);
    }
  };

  return <Modal title={`解析字段配置 · 草稿 V${version.versionNumber}`} subtitle="保存后仍需在版本管理中发布，已发布版本不会被直接修改" close={close}>
    <div className="section-editor">
      <div className="section-pick">
        {sections.map((item) => <button
          className={item.id === version.sectionId ? "active" : ""}
          key={item.id}
          onClick={() => selectSection(item)}
        >{item.name}</button>)}
      </div>
      <div className="prompt-editor">
        <label>板块说明<textarea rows={3} value={section.prompt} onChange={(event) => setSection({ ...section, prompt: event.target.value })} /></label>
        {isGeneric
          ? <section className="version-import-contract" aria-labelledby="version-import-contract-heading">
            <h3 id="version-import-contract-heading">导入表头契约</h3>
            <label>聊天截图表头<input value={contract.imageColumn} onChange={(event) => updateContract({ imageColumn: event.target.value })} /></label>
            <label>必需辅助表头<input value={contract.requiredColumns.join(", ")} placeholder="平台, 店铺名称" onChange={(event) => updateContract({ requiredColumns: parseList(event.target.value) })} /></label>
            <label>可选辅助表头<input value={contract.optionalColumns.join(", ")} placeholder="订单号, 客服备注" onChange={(event) => updateContract({ optionalColumns: parseList(event.target.value) })} /></label>
          </section>
          : <label>Excel 表头字段<textarea rows={2} value={(section.sourceFields ?? []).join(", ")} onChange={(event) => setSection({ ...section, sourceFields: parseList(event.target.value) })} /></label>}
        <FieldConfigEditor
          fields={fields}
          sectionId={version.sectionId}
          onValidationChange={updateFieldError}
          sourceFields={section.sourceFields ?? []}
          allowInputSources
          onChange={updateField}
          onMove={(fromIndex, toIndex) => setFields((current) => moveField(current, fromIndex, toIndex))}
          onAdd={() => setFields((current) => [...current, newField(version.sectionId, current)])}
          onRemove={(index) => setFields((current) => current.filter((_, fieldIndex) => fieldIndex !== index))}
        />
      </div>
    </div>
    {error && <div className="form-error">{error}</div>}
    <div className="modal-actions">
      <button className="button light" disabled={saving} onClick={close}>取消</button>
      <button className="button dark" disabled={saving || Boolean(Object.values(fieldErrors).find(Boolean))} onClick={() => void saveDraft()}>
        {saving ? "保存中..." : "保存草稿配置"}
      </button>
    </div>
  </Modal>;
}
