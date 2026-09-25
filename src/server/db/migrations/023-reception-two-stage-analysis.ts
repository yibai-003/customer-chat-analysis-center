import crypto from "node:crypto";

interface SnapshotField {
  key: string;
  executionType?: string;
  imageEnabled?: boolean;
  dependsOn?: string[];
  [key: string]: unknown;
}

function strictTwoStageFields(fields: SnapshotField[]) {
  return fields.map((field) => {
    if (field.key === "截图内容总结") {
      return {
        ...field,
        executionType: "reception_screenshot_facts",
        imageEnabled: true,
        dependsOn: [],
      };
    }
    if (field.key === "统一质检分析") {
      return {
        ...field,
        executionType: "reception_quality_analysis",
        imageEnabled: false,
        dependsOn: ["截图内容总结"],
      };
    }
    return field;
  });
}

function hasStrictTwoStage(fields: SnapshotField[]) {
  const facts = fields.find((field) => field.key === "截图内容总结");
  const quality = fields.find((field) => field.key === "统一质检分析");
  return facts?.executionType === "reception_screenshot_facts"
    && facts.imageEnabled === true
    && Array.isArray(facts.dependsOn)
    && facts.dependsOn.length === 0
    && quality?.executionType === "reception_quality_analysis"
    && quality.imageEnabled === false
    && JSON.stringify(quality.dependsOn) === JSON.stringify(["截图内容总结"]);
}

export function applyReceptionTwoStageAnalysis(db: any) {
  const timestamp = new Date().toISOString();
  db.prepare(`
    UPDATE analysis_fields
    SET execution_type = 'reception_screenshot_facts',
        image_enabled = 1,
        depends_on_json = '[]',
        updated_at = ?
    WHERE section_id = 'reception' AND key = '截图内容总结'
  `).run(timestamp);
  db.prepare(`
    UPDATE analysis_fields
    SET execution_type = 'reception_quality_analysis',
        image_enabled = 0,
        depends_on_json = '["截图内容总结"]',
        updated_at = ?
    WHERE section_id = 'reception' AND key = '统一质检分析'
  `).run(timestamp);

  const current = db.prepare(`
    SELECT *
    FROM analysis_section_versions
    WHERE section_id = 'reception' AND is_current = 1
  `).get() as any;
  if (!current) return;

  const fields = JSON.parse(current.fields_snapshot_json) as SnapshotField[];
  if (hasStrictTwoStage(fields)) return;
  const nextFields = strictTwoStageFields(fields);
  if (!hasStrictTwoStage(nextFields)) {
    throw new Error("接待质检两阶段字段配置无法恢复");
  }
  const dependencies = nextFields.map((field) => ({
    key: field.key,
    dependsOn: Array.isArray(field.dependsOn) ? field.dependsOn : [],
  }));
  const nextNumber = (db.prepare(`
    SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number
    FROM analysis_section_versions
    WHERE section_id = 'reception'
  `).get() as { next_number: number }).next_number;
  const id = `section-version-reception-v${nextNumber}-${crypto.randomUUID()}`;

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
    id,
    nextNumber,
    current.section_snapshot_json,
    JSON.stringify(nextFields),
    current.export_settings_json,
    JSON.stringify(dependencies),
    current.knowledge_snapshot_json,
    current.business_rules_json,
    timestamp,
    timestamp,
    timestamp,
  );

  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_events'").get()) {
    db.prepare(`
      INSERT INTO audit_events (
        id, organization_id, actor_user_id, actor_display, action, target_type,
        target_id, outcome, metadata_json, correlation_id, occurred_at
      ) VALUES (?, 'org-default', NULL, '系统', 'config.version_migration',
        'section', 'reception', 'success', ?, NULL, ?)
    `).run(
      crypto.randomUUID(),
      JSON.stringify({
        sectionId: "reception",
        fromVersionId: current.id,
        versionNumber: nextNumber,
        upgrade: "reception-two-stage-analysis",
      }),
      timestamp,
    );
  }
}
