import { db, initDb } from "./db/client";
import { captureCatalog } from "./services/knowledge/knowledge-sync-service";

initDb({ preserveConfiguration: true });
const integrity = db.pragma("integrity_check", { simple: true });
if (integrity !== "ok") throw new Error(`数据库完整性检查失败：${integrity}`);
const foreignKeys = db.pragma("foreign_key_check");
if (foreignKeys.length) throw new Error(`外键检查失败：${JSON.stringify(foreignKeys)}`);
const catalog = captureCatalog();
console.log(JSON.stringify({ integrity, foreignKeys: 0, sections: catalog.sections.length, fields: catalog.fields.length, bases: catalog.bases.length, items: catalog.items.length }, null, 2));
