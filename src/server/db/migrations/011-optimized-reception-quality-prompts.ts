import {
  RECEPTION_QUALITY_FIELD_PROMPT,
  RECEPTION_SCREENSHOT_FACTS_PROMPT,
} from "../../services/reception-quality-rules";

export function applyOptimizedReceptionQualityConfiguration(db: any) {
  const section = db.prepare("SELECT id FROM analysis_sections WHERE id = 'reception'").get();
  if (!section) return;
  const timestamp = new Date().toISOString();
  db.prepare(`UPDATE analysis_fields SET
    field_type = 'object', prompt = ?, image_enabled = 1, depends_on_json = '[]',
    execution_type = 'ai', is_required = 1, is_enabled = 1, updated_at = ?
    WHERE section_id = 'reception' AND key = '截图内容总结'`)
    .run(RECEPTION_SCREENSHOT_FACTS_PROMPT, timestamp);
  db.prepare(`UPDATE analysis_fields SET
    field_type = 'object', prompt = ?, image_enabled = 0, depends_on_json = '["截图内容总结"]',
    execution_type = 'reception_quality_analysis', is_required = 1, is_enabled = 1, updated_at = ?
    WHERE section_id = 'reception' AND key = '统一质检分析'`)
    .run(RECEPTION_QUALITY_FIELD_PROMPT, timestamp);
}

export function applyOptimizedReceptionQualityPrompts(db: any) {
  applyOptimizedReceptionQualityConfiguration(db);
}
