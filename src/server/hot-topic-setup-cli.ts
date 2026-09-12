import fs from "node:fs";
import path from "node:path";
import { db } from "./db/client";
import { config } from "./config";
import { listFields, upsertField } from "./services/field-config-service";
import { initializeKnowledgeSync } from "./services/knowledge/knowledge-sync-service";
import { getKnowledgeBase, upsertKnowledgeBase } from "./services/knowledge/knowledge-repository";
import { HOT_TOPIC_BASE_ID, HOT_TOPIC_BASE_NAME, HOT_TOPIC_PROMPT, HOT_TOPIC_QUESTION_COLUMN, HOT_TOPIC_SECTION_ID } from "../shared/hot-topic";

if (db.prepare("SELECT id FROM jobs WHERE status = 'processing'").get()) {
  throw new Error("请等待当前解析任务结束后再配置热点话题");
}
const backup = path.join(config.dataDir, "backups", `hot-topic-setup-${Date.now()}`);
fs.mkdirSync(backup, { recursive: true });
await db.backup(path.join(backup, "app.db"));
fs.copyFileSync(path.resolve("knowledge/catalog.json"), path.join(backup, "catalog.json"));
const sync = initializeKnowledgeSync();
const fields = listFields(HOT_TOPIC_SECTION_ID);
const field = fields.find((item) => item.key === "高频问题" || item.label === "高频问题");
const source = fields.find((item) => item.key === "截图解析" && item.isEnabled);
if (!field || !source) throw new Error("请先完善热点话题的截图解析和高频问题字段");
db.transaction(() => {
  if (!getKnowledgeBase(HOT_TOPIC_BASE_ID)) upsertKnowledgeBase({
    id: HOT_TOPIC_BASE_ID, sectionId: HOT_TOPIC_SECTION_ID, name: HOT_TOPIC_BASE_NAME,
    originalFilename: "AI 自动补充", isEnabled: true,
    columns: [{ name: HOT_TOPIC_QUESTION_COLUMN, roles: ["result", "search"] }, { name: "来源", roles: ["metadata"] }],
  });
  upsertField({ ...field, prompt: HOT_TOPIC_PROMPT, executionType: "ai", type: "string", required: false,
    imageEnabled: false, options: [], dependsOn: [...new Set([...field.dependsOn, source.key])],
    knowledgeSyncEnabled: true, knowledgeCaptureLimit: 2 });
})();
sync.export();
console.log(JSON.stringify({ configured: true, section: HOT_TOPIC_SECTION_ID, field: field.key,
  knowledgeBase: HOT_TOPIC_BASE_NAME, maxQuestions: 2, backup }, null, 2));
db.close();
