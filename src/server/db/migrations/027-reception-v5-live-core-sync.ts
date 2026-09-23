export function applyReceptionV5LiveCoreSync(db: any) {
  const current = db.prepare(`
    SELECT fields_snapshot_json
    FROM analysis_section_versions
    WHERE section_id = 'reception' AND is_current = 1
  `).get() as { fields_snapshot_json: string } | undefined;
  if (!current) return;
  const fields = JSON.parse(current.fields_snapshot_json) as Array<Record<string, any>>;
  const coreFields = fields.filter((field) =>
    field.key === "截图内容总结" || field.key === "统一质检分析");
  const update = db.prepare(`
    UPDATE analysis_fields
    SET label = ?, field_type = ?, prompt = ?, options_json = ?, output_column = ?,
        is_required = ?, image_enabled = ?, depends_on_json = ?, sort_order = ?,
        execution_type = ?, export_enabled = ?, is_enabled = ?, updated_at = ?
    WHERE section_id = 'reception' AND key = ?
  `);
  const timestamp = new Date().toISOString();
  for (const field of coreFields) {
    update.run(
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
      field.isEnabled === false ? 0 : 1,
      timestamp,
      field.key,
    );
  }
}
