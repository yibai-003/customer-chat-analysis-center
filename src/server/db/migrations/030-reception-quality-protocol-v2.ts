import crypto from "node:crypto";
import {
  RECEPTION_V2_QUALITY_PROMPT,
  RECEPTION_V2_SCREENSHOT_FACTS_PROMPT,
} from "../../services/reception-quality-v2-prompts";
import { receptionV2IssueRules } from "../../services/section-business-rules";

function parseJson(value: string | null | undefined, fallback: unknown) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function audit(db: any, metadata: Record<string, unknown>, timestamp: string) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_events'").get()) return;
  db.prepare(`
    INSERT INTO audit_events (
      id, organization_id, actor_user_id, actor_display, action, target_type,
      target_id, outcome, metadata_json, correlation_id, occurred_at
    ) VALUES (?, 'org-default', NULL, '系统', 'config.version_migration',
      'section', 'reception', 'success', ?, NULL, ?)
  `).run(crypto.randomUUID(), JSON.stringify(metadata), timestamp);
}

export function applyReceptionQualityProtocolV2(db: any): void {
  const section = db.prepare("SELECT * FROM analysis_sections WHERE id = 'reception'").get() as any;
  const current = db.prepare(`
    SELECT *
    FROM analysis_section_versions
    WHERE section_id = 'reception' AND status = 'published' AND is_current = 1
  `).get() as any;
  if (!section || !current) return;

  const previousRules = parseJson(current.business_rules_json, {}) as Record<string, unknown>;
  if (previousRules.analysisProtocol === "v2") return;

  const fields = structuredClone(parseJson(current.fields_snapshot_json, [])) as Array<Record<string, any>>;
  const facts = fields.find((field) => field.key === "截图内容总结");
  const quality = fields.find((field) => field.key === "统一质检分析");
  if (!facts || !quality) {
    throw new Error("接待质检缺少两阶段核心字段（截图内容总结、统一质检分析），无法创建 V2");
  }

  facts.prompt = RECEPTION_V2_SCREENSHOT_FACTS_PROMPT;
  quality.prompt = RECEPTION_V2_QUALITY_PROMPT;
  const businessRules = structuredClone(previousRules);
  businessRules.analysisProtocol = "v2";
  businessRules.issues = receptionV2IssueRules();

  const sectionSnapshot = parseJson(current.section_snapshot_json, {}) as Record<string, any>;
  const timestamp = new Date().toISOString();
  const nextNumber = (db.prepare(`
    SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number
    FROM analysis_section_versions
    WHERE section_id = 'reception'
  `).get() as { next_number: number }).next_number;
  const versionId = `section-version-reception-v${nextNumber}-${crypto.randomUUID()}`;

  db.prepare(`
    UPDATE analysis_sections
    SET parent_id = ?, name = ?, prompt = ?, output_schema_json = ?,
        source_fields_json = ?, sort_order = ?, is_enabled = ?,
        image_enabled = ?, updated_at = ?
    WHERE id = 'reception'
  `).run(
    sectionSnapshot.parentId ?? null,
    sectionSnapshot.name,
    sectionSnapshot.prompt,
    JSON.stringify(sectionSnapshot.outputSchema ?? []),
    JSON.stringify(sectionSnapshot.sourceFields ?? []),
    sectionSnapshot.sortOrder,
    sectionSnapshot.isEnabled ? 1 : 0,
    sectionSnapshot.imageEnabled ? 1 : 0,
    timestamp,
  );

  const updateField = db.prepare(`
    UPDATE analysis_fields
    SET label = ?, field_type = ?, prompt = ?, options_json = ?, output_column = ?,
        is_required = ?, image_enabled = ?, depends_on_json = ?, sort_order = ?,
        execution_type = ?, export_enabled = ?, knowledge_base_id = ?, candidate_limit = ?,
        match_field_key = ?, knowledge_column = ?, knowledge_sync_enabled = ?,
        knowledge_capture_limit = ?, is_enabled = ?, updated_at = ?
    WHERE section_id = 'reception' AND key = ?
  `);
  for (const field of [facts, quality]) {
    updateField.run(
      field.label,
      field.type,
      field.prompt,
      JSON.stringify(field.options ?? []),
      field.outputColumn ?? null,
      field.required ? 1 : 0,
      field.imageEnabled ? 1 : 0,
      JSON.stringify(field.dependsOn ?? []),
      field.sortOrder,
      field.executionType,
      field.exportEnabled === false ? 0 : 1,
      field.knowledgeBaseId ?? null,
      field.candidateLimit ?? 15,
      field.matchFieldKey ?? null,
      field.knowledgeColumn ?? null,
      field.knowledgeSyncEnabled ? 1 : 0,
      field.knowledgeCaptureLimit ?? 2,
      field.isEnabled === false ? 0 : 1,
      timestamp,
      field.key,
    );
  }

  db.prepare(`
    UPDATE analysis_section_versions
    SET is_current = 0, updated_at = ?
    WHERE section_id = 'reception' AND is_current = 1
  `).run(timestamp);
  db.prepare(`
    INSERT INTO analysis_section_versions (
      id, section_id, version_number, status, is_current,
      section_snapshot_json, fields_snapshot_json, export_settings_json,
      dependencies_snapshot_json, knowledge_snapshot_json, business_rules_json,
      created_at, updated_at, published_at, archived_at
    ) VALUES (?, 'reception', ?, 'published', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    versionId,
    nextNumber,
    current.section_snapshot_json,
    JSON.stringify(fields),
    current.export_settings_json,
    current.dependencies_snapshot_json,
    current.knowledge_snapshot_json,
    JSON.stringify(businessRules),
    timestamp,
    timestamp,
    timestamp,
  );
  audit(db, {
    sectionId: "reception",
    fromVersionId: current.id,
    versionNumber: nextNumber,
    upgrade: "reception-quality-protocol-v2",
  }, timestamp);
}
