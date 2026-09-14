import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { db, initDb } from "../../db/client";
import { config } from "../../config";
import { buildKnowledgePathKey, buildKnowledgeSearchText } from "./knowledge-repository";
import type { KnowledgeColumn } from "../../../shared/types";

const text = z.string();
const id = text.min(1);
const flag = z.union([z.literal(0), z.literal(1)]);
const integer = z.number().int();
const json = (schema: z.ZodType) => text.refine((value) => {
  try { return schema.safeParse(JSON.parse(value)).success; } catch { return false; }
}, "Invalid JSON value");
const columns = z.array(z.object({
  name: id,
  roles: z.array(z.enum(["result", "search", "keyword", "description", "positive_example", "negative_example", "metadata"])),
  requiredParent: text.optional(),
}));
const schemas = {
  sections: z.object({
    id, parent_id: id.nullable(), name: text, prompt: text,
    output_schema_json: json(z.array(z.object({ key: id, label: text, type: text }))),
    source_fields_json: json(z.array(text)), sort_order: integer, is_enabled: flag, image_enabled: flag,
  }).strict(),
  fields: z.object({
    id, section_id: id, key: id, label: text, field_type: text, prompt: text,
    options_json: json(z.array(z.unknown())), output_column: text.nullable(), is_required: flag,
    image_enabled: flag, depends_on_json: json(z.array(text)), sort_order: integer,
    execution_type: z.enum(["ai", "knowledge_match", "knowledge_extract"]), export_enabled: flag,
    knowledge_base_id: id.nullable(), candidate_limit: integer, match_field_key: text.nullable(),
    knowledge_column: text.nullable(), knowledge_sync_enabled: flag.optional().default(0), knowledge_capture_limit: z.union([z.literal(1), z.literal(2)]).optional().default(2), is_enabled: flag,
  }).strict(),
  bases: z.object({
    id, section_id: id, name: text, original_filename: text,
    column_schema_json: json(columns), is_enabled: flag,
  }).strict(),
  items: z.object({
    id, knowledge_base_id: id, values_json: json(z.record(text, text)),
    is_enabled: flag, source_row_number: integer.nullable(),
  }).strict(),
};
const catalogSchema = z.object({
  version: z.literal(1), sections: z.array(schemas.sections), fields: z.array(schemas.fields),
  bases: z.array(schemas.bases), items: z.array(schemas.items),
}).strict();
type Catalog = z.infer<typeof catalogSchema>;
const tables = { sections: "analysis_sections", fields: "analysis_fields", bases: "knowledge_bases", items: "knowledge_items" } as const;
type Group = keyof typeof tables;
const groups = Object.keys(tables) as Group[];

export function validateCatalog(input: unknown): Catalog {
  const catalog = catalogSchema.parse(input);
  for (const group of groups) {
    const rows = catalog[group];
    if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error(`Duplicate IDs: ${group}`);
    rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  const sections = new Map(catalog.sections.map((s) => [s.id, s]));
  const bases = new Map(catalog.bases.map((b) => [b.id, b]));
  for (const s of catalog.sections) {
    const seen = new Set([s.id]);
    let parent = s.parent_id;
    while (parent) {
      if (!sections.has(parent) || seen.has(parent)) throw new Error(`Invalid section parent: ${s.id}`);
      seen.add(parent); parent = sections.get(parent)!.parent_id;
    }
  }
  const fieldKeys = new Set<string>();
  for (const f of catalog.fields) {
    const key = JSON.stringify([f.section_id, f.key]);
    if (!sections.has(f.section_id) || fieldKeys.has(key)) throw new Error(`Invalid field: ${f.id}`);
    fieldKeys.add(key);
    if (f.knowledge_base_id && bases.get(f.knowledge_base_id)?.section_id !== f.section_id) {
      throw new Error(`Invalid knowledge base reference: ${f.id}`);
    }
  }
  for (const b of catalog.bases) if (!sections.has(b.section_id)) throw new Error(`Invalid base section: ${b.id}`);
  const paths = new Set<string>();
  for (const item of catalog.items) {
    const base = bases.get(item.knowledge_base_id);
    if (!base) throw new Error(`Invalid item base: ${item.id}`);
    const key = JSON.stringify([base.id, buildKnowledgePathKey(JSON.parse(base.column_schema_json), JSON.parse(item.values_json))]);
    if (paths.has(key)) throw new Error(`Duplicate knowledge path: ${item.id}`);
    paths.add(key);
  }
  return catalog;
}

export function captureCatalog(database = db): Catalog {
  const result: Record<string, unknown> = { version: 1 };
  for (const group of groups) {
    const columns = Object.keys(schemas[group].shape);
    result[group] = database.prepare(`SELECT ${columns.join(",")} FROM ${tables[group]} ORDER BY id`).all();
    if (group === "fields") for (const row of result[group] as Record<string, unknown>[]) {
      // Keep the digest of pre-feature catalogs stable so an upgrade is not a sync conflict.
      if (row.knowledge_sync_enabled === 0) delete row.knowledge_sync_enabled;
      if (row.knowledge_capture_limit === 2) delete row.knowledge_capture_limit;
    }
  }
  return validateCatalog(result);
}

const serialize = (catalog: Catalog) => JSON.stringify(catalog, null, 2) + "\n";
const digest = (catalog: Catalog) => crypto.createHash("sha256").update(serialize(catalog)).digest("hex");
function atomicWrite(file: string, contents: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, contents, "utf8"); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}

export function restoreCatalog(input: unknown) {
  const catalog = validateCatalog(input);
  const timestamp = new Date().toISOString();
  db.transaction(() => {
    // Remove missing definitions in dependency order; keep IDs of surviving fields/runs.
    for (const group of ["items", "fields", "bases", "sections"] as Group[]) {
      const keep = new Set(catalog[group].map((r) => r.id));
      for (const row of db.prepare(`SELECT id FROM ${tables[group]}`).all() as { id: string }[]) {
        if (!keep.has(row.id)) db.prepare(`DELETE FROM ${tables[group]} WHERE id = ?`).run(row.id);
      }
    }
    // Rebuild derived search indexes and path keys, including edits that exchange paths.
    db.exec("DELETE FROM knowledge_item_fts; DELETE FROM knowledge_items;");
    for (const group of ["sections", "bases", "fields", "items"] as Group[]) {
      for (const row of catalog[group]) {
        const values: Record<string, unknown> = { ...row, created_at: timestamp, updated_at: timestamp };
        if (group === "fields") {
          values.knowledge_sync_enabled ??= 0;
          values.knowledge_capture_limit ??= 2;
        }
        if (group === "bases") values.item_count = catalog.items.filter((i) => i.knowledge_base_id === row.id).length;
        if (group === "items") {
          const item = row as Catalog["items"][number];
          const base = catalog.bases.find((b) => b.id === item.knowledge_base_id)!;
          const columns = JSON.parse(base.column_schema_json) as KnowledgeColumn[];
          const contents = JSON.parse(item.values_json) as Record<string, string>;
          values.path_key = buildKnowledgePathKey(columns, contents);
          values.search_text = buildKnowledgeSearchText(columns, contents);
        }
        const keys = Object.keys(values);
        db.prepare(`INSERT INTO ${tables[group]} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})
          ON CONFLICT(id) DO UPDATE SET ${keys.filter((k) => k !== "id" && k !== "created_at").map((k) => `${k}=excluded.${k}`).join(",")}`)
          .run(...keys.map((k) => values[k]));
        if (group === "items") db.prepare("INSERT INTO knowledge_item_fts(item_id,knowledge_base_id,search_text) VALUES(?,?,?)")
          .run(row.id, values.knowledge_base_id, values.search_text);
      }
    }
  })();
}

export class KnowledgeSync {
  readonly file: string;
  readonly stateFile: string;
  private baseline?: string;
  private outbox() {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='knowledge_sync_outbox'").get()) return undefined;
    return db.prepare("SELECT * FROM knowledge_sync_outbox WHERE id=1").get() as {
      revision: number; exported_revision: number; scope: string | null; baseline_hash: string | null;
      pending_hash: string | null; last_error: string | null; exported_at: string | null;
    } | undefined;
  }
  constructor(file = path.resolve("knowledge/catalog.json"), stateFile = path.join(config.dataDir, "knowledge-sync-state.json")) {
    this.file = file; this.stateFile = stateFile;
    if (fs.existsSync(stateFile)) this.baseline = z.object({ hash: z.string() }).parse(JSON.parse(fs.readFileSync(stateFile, "utf8"))).hash;
    const state = this.outbox();
    if (state?.scope === path.resolve(this.file) && state.baseline_hash) this.baseline = state.baseline_hash;
  }
  private read() { return validateCatalog(JSON.parse(fs.readFileSync(this.file, "utf8"))); }
  private remember(catalog: Catalog) {
    const hash = digest(catalog);
    atomicWrite(this.stateFile, JSON.stringify({ hash }) + "\n");
    this.baseline = hash;
    db.prepare(`UPDATE knowledge_sync_outbox SET exported_revision=revision,scope=?,baseline_hash=?,
      pending_hash=NULL,last_error=NULL,exported_at=? WHERE id=1`).run(path.resolve(this.file), hash, new Date().toISOString());
  }
  private backup() {
    const folder = path.join(config.dataDir, "backups");
    fs.mkdirSync(folder, { recursive: true });
    const backup = path.join(folder, `before-knowledge-sync-${Date.now()}-${crypto.randomUUID()}.db`);
    db.prepare("VACUUM INTO ?").run(backup);
  }
  initialize(freshDatabase: boolean) {
    const local = captureCatalog();
    const state = this.outbox();
    if (!freshDatabase && state?.scope === path.resolve(this.file) && state.baseline_hash
      && (state.revision !== state.exported_revision || state.pending_hash)) {
      // Keep a recoverable export failure available through the UI. Conflicts still block startup.
      try { this.assertUnchanged(); } catch { throw new Error("知识库同步冲突：仓库快照和本地数据库均有修改，数据未覆盖。"); }
      try { this.export(); } catch { /* durable pending status is retained */ }
      return;
    }
    if (!fs.existsSync(this.file)) {
      if (this.baseline) throw new Error("知识库快照被删除，请恢复 knowledge/catalog.json 后重启。");
      this.export(); return;
    }
    const incoming = this.read();
    if (digest(incoming) === digest(local)) { this.remember(incoming); return; }
    if (freshDatabase || (this.baseline && digest(local) === this.baseline)) {
      this.backup(); restoreCatalog(incoming); this.remember(incoming); return;
    }
    if (this.baseline && digest(incoming) === this.baseline) { this.export(); return; }
    throw new Error("知识库同步冲突：仓库快照和本地数据库均有修改。数据未覆盖，请先备份并合并 knowledge/catalog.json。");
  }
  assertUnchanged() {
    const state = this.outbox();
    const baseline = state?.scope === path.resolve(this.file) ? state.baseline_hash ?? this.baseline : this.baseline;
    const incoming = fs.existsSync(this.file) ? digest(this.read()) : undefined;
    const pending = state?.scope === path.resolve(this.file) ? state.pending_hash : undefined;
    if (baseline && incoming !== baseline && (!pending || incoming !== pending)) {
      throw new Error("仓库知识库已变更，请重启服务完成恢复后再编辑。");
    }
  }
  restore() {
    const catalog = this.read();
    this.backup();
    restoreCatalog(catalog);
    this.remember(catalog);
    return { file: this.file, bases: catalog.bases.length, items: catalog.items.length };
  }
  export() {
    this.assertUnchanged();
    const catalog = captureCatalog();
    const contents = serialize(catalog);
    db.prepare("UPDATE knowledge_sync_outbox SET scope=?,pending_hash=? WHERE id=1").run(path.resolve(this.file), digest(catalog));
    try {
      if (!fs.existsSync(this.file) || fs.readFileSync(this.file, "utf8") !== contents) atomicWrite(this.file, contents);
      this.remember(catalog);
    } catch (error) {
      db.prepare("UPDATE knowledge_sync_outbox SET last_error='EXPORT_FAILED' WHERE id=1").run();
      throw error;
    }
    return { file: this.file, bases: catalog.bases.length, items: catalog.items.length };
  }
  status() {
    const state = this.outbox();
    let conflict = false;
    try { this.assertUnchanged(); } catch { conflict = true; }
    return { state: conflict ? "conflict" : state?.revision !== state?.exported_revision || state?.pending_hash ? "pending" : "synced",
      localSaved: true, snapshotReady: !conflict && state?.revision === state?.exported_revision && !state?.pending_hash,
      github: "not_checked", lastExportedAt: state?.exported_at ?? null, error: state?.last_error ?? null };
  }
}

export function initializeKnowledgeSync() {
  const fresh = !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='analysis_sections'").get();
  const sync = new KnowledgeSync();
  initDb({ preserveConfiguration: !fresh && (fs.existsSync(sync.file) || fs.existsSync(sync.stateFile)) });
  sync.initialize(fresh);
  return sync;
}
