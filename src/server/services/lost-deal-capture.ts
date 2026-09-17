import { db } from "../db/client";
import { assertRecordOwnership } from "./run-ownership";
import type { LostDealAttribution, LostDealReason } from "./lost-deal-attribution";
import { LOST_DEAL_CUSTOMER_BASE_NAME, LOST_DEAL_SERVICE_BASE_NAME } from "./lost-deal-attribution";

export function replaceLostDealReasonLinks(
  recordId: string,
  fieldId: string,
  attribution: LostDealAttribution,
  enabled: boolean,
) {
  if (!db.inTransaction) throw new Error("归因关联必须与字段运行在同一事务中写入");
  assertRecordOwnership(recordId);
  const field = db.prepare("SELECT section_id FROM analysis_fields WHERE id = ?").get(fieldId) as { section_id: string } | undefined;
  if (!field) throw new Error("归因字段已删除");
  db.prepare("DELETE FROM lost_deal_record_reasons WHERE record_id = ? AND field_id = ?").run(recordId, fieldId);
  if (!enabled || attribution.reviewRequired) return;

  const item = db.prepare(`
    SELECT i.values_json, i.is_enabled AS item_enabled, b.is_enabled AS base_enabled,
      b.name AS base_name, b.section_id
    FROM knowledge_items i JOIN knowledge_bases b ON b.id = i.knowledge_base_id
    WHERE i.id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO lost_deal_record_reasons
      (record_id, field_id, knowledge_item_id, reason_type, reason_name, evidence)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const capture = (reasons: LostDealReason[], type: "customer" | "service", baseName: string, valueColumn: string) => {
    for (const reason of reasons) {
      if (!reason.knowledgeItemId || reason.name === "待复核" || !reason.evidence) continue;
      const row = item.get(reason.knowledgeItemId) as {
        values_json: string; item_enabled: number; base_enabled: number; base_name: string; section_id: string;
      } | undefined;
      const values = row ? JSON.parse(row.values_json) as Record<string, string> : {};
      if (!row || !row.item_enabled || !row.base_enabled || row.section_id !== field.section_id
        || row.base_name !== baseName || values[valueColumn] !== reason.name) {
        throw new Error("未成交原因知识条目在归因期间已变更，请重试");
      }
      insert.run(recordId, fieldId, reason.knowledgeItemId, type, reason.name, reason.evidence);
    }
  };
  capture(attribution.customerReasons, "customer", LOST_DEAL_CUSTOMER_BASE_NAME, "原因名称");
  capture(attribution.serviceReasons, "service", LOST_DEAL_SERVICE_BASE_NAME, "问题名称");
}
