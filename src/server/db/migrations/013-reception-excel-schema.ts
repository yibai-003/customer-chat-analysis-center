import { RECEPTION_EXCEL_FIELDS } from "../../services/reception-quality-rules";

const OUTPUT_COLUMNS: Record<string, string> = {
  "问题点-售前": "问题点-售前",
  "问题点-售后": "问题点-售后",
  "有无违规-售后": "有无违规-售后",
  "客服问题识别问题并打标签": "客服问题 识别问题并打标签",
  "接待流程质检结果": "接待流程质检结果",
  "优化建议-售前": "优化建议-售前",
};

export function applyReceptionExcelSchemaConfiguration(db: any) {
  const section = db.prepare("SELECT id FROM analysis_sections WHERE id = 'reception'").get();
  if (!section) return;
  const timestamp = new Date().toISOString();
  db.prepare("UPDATE analysis_sections SET source_fields_json = ?, updated_at = ? WHERE id = 'reception'")
    .run(JSON.stringify(RECEPTION_EXCEL_FIELDS), timestamp);
  const update = db.prepare(`UPDATE analysis_fields
    SET output_column = ?, updated_at = ?
    WHERE section_id = 'reception' AND key = ?`);
  for (const [key, outputColumn] of Object.entries(OUTPUT_COLUMNS)) {
    update.run(outputColumn, timestamp, key);
  }
}

export function applyReceptionExcelSchema(db: any) {
  applyReceptionExcelSchemaConfiguration(db);
}
