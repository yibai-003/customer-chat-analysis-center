import { db } from "../../db/client";

export function extractKnowledgeValue(input: {
  recordId: string;
  sectionId: string;
  matchFieldKey: string;
  matchFieldId?: string;
  matchValue?: string;
  knowledgeColumn: string;
  outputKey: string;
}): Record<string, string> {
  if (!input.matchValue?.trim()) return { [input.outputKey]: "" };
  const snapshot = input.matchFieldId
    ? db.prepare(`
      SELECT item_values_json FROM knowledge_match_snapshots
      WHERE record_id = ? AND field_id = ? AND knowledge_item_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(input.recordId, input.matchFieldId, input.matchValue)
    : db.prepare(`
      SELECT snapshots.item_values_json
      FROM knowledge_match_snapshots snapshots
      JOIN analysis_fields fields ON fields.id = snapshots.field_id
      WHERE snapshots.record_id = ? AND fields.section_id = ? AND fields.key = ?
        AND snapshots.knowledge_item_id = ?
      ORDER BY snapshots.created_at DESC, snapshots.rowid DESC LIMIT 1
    `).get(input.recordId, input.sectionId, input.matchFieldKey, input.matchValue) as
    | { item_values_json: string }
    | undefined;
  if (!snapshot) return { [input.outputKey]: "" };

  const values = JSON.parse(snapshot.item_values_json || "{}") as Record<string, unknown>;
  const value = values[input.knowledgeColumn];
  return {
    [input.outputKey]: typeof value === "string" ? value : value == null ? "" : String(value),
  };
}
