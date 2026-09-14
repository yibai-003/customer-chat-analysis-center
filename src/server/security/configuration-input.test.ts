import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db, initDb } from "../db/client";
import { getSection, upsertSection } from "../db/repositories";
import { getField, upsertField } from "../services/field-config-service";
import { createModelConfig } from "../services/model-config-service";
import { upsertKnowledgeBase, upsertKnowledgeItem } from "../services/knowledge/knowledge-repository";
import { createApp } from "../app";

beforeAll(() => initDb());
const revision = () => db.prepare("SELECT revision FROM knowledge_sync_outbox").get().revision;
describe("configuration writes validate before mutation", () => {
  it.each([{ type: "array" }, { executionType: "shell" }, { imageEnabled: "false" }, { isEnabled: 1 }, { candidateLimit: 31 }, { key: "__proto__" }, { key: "constructor" }])("rejects invalid field input %j without dirtying the snapshot", patch => {
    const before = revision();
    expect(() => upsertField({ sectionId: "refund", key: "合法字段", label: "字段", type: "string", ...patch } as any)).toThrow();
    expect(revision()).toBe(before);
  });
  it("rejects cross-section field moves and dependency cycles before writes", () => {
    const sectionId = randomUUID(); upsertSection({ id: sectionId, name: "test", prompt: "", sourceFields: ["b"] });
    const a = upsertField({ sectionId, key: "a", label: "a", type: "string", dependsOn: ["b"] });
    const before = revision();
    expect(() => upsertField({ ...a, sectionId: "refund" })).toThrow("不能移动");
    expect(() => upsertField({ sectionId, key: "b", label: "b", type: "string", dependsOn: ["a"] })).toThrow("循环依赖");
    expect(getField(a.id)?.sectionId).toBe(sectionId); expect(revision()).toBe(before);
  });
  it("rejects invalid output schema and parent cycles and persists disabled sections", () => {
    const parent = upsertSection({ name: "parent", prompt: "", isEnabled: false })!;
    const child = upsertSection({ name: "child", prompt: "", parentId: parent.id })!;
    const before = revision();
    expect(() => upsertSection({ id: parent.id, name: "parent", prompt: "", parentId: child.id })).toThrow("循环");
    expect(() => upsertSection({ name: "bad", prompt: "", outputSchema: [{ key: "reason", label: "r", type: "script" }] } as any)).toThrow();
    expect(() => upsertSection({ name: "bad", prompt: "", isEnabled: "false" } as any)).toThrow();
    expect(revision()).toBe(before); expect(getSection(parent.id)?.isEnabled).toBe(false);
    upsertSection({ id: parent.id, name: "renamed", prompt: "" }); expect(getSection(parent.id)?.isEnabled).toBe(false);
  });
  it.each([
    { columns: [{ name: "reason", roles: ["unknown"] }] },
    { columns: [{ name: "reason", roles: ["result", "result"] }] },
    { columns: [{ name: "reason", roles: ["result"] }, { name: "reason", roles: ["search"] }] },
    { columns: [{ name: "a", roles: ["result"], requiredParent: "b" }, { name: "b", roles: ["result"], requiredParent: "a" }] },
  ])("rejects malformed column mapping before inserting a base", ({ columns }) => {
    const before = revision();
    expect(() => upsertKnowledgeBase({ name: "invalid", sectionId: "refund", originalFilename: "test.xlsx", isEnabled: true, columns } as any)).toThrow();
    expect(revision()).toBe(before);
  });
  it("rejects numeric and object knowledge values rather than coercing them into search text", () => {
    const base = upsertKnowledgeBase({ name: "valid", sectionId: "refund", originalFilename: "test.xlsx", isEnabled: true, columns: [{ name: "reason", roles: ["result"] }] });
    const before = revision();
    for (const value of [123, {}, null]) expect(() => upsertKnowledgeItem({ knowledgeBaseId: base.id, values: { reason: value }, isEnabled: true } as any)).toThrow();
    expect(revision()).toBe(before);
  });
  it.each(["file:///tmp/key", "https://user:pass@example.com/v1", "https://example.com/v1?api_key=secret", "https://example.com/v1#fragment"])("rejects non-API base URL %s", baseUrl => {
    const before = db.prepare("SELECT COUNT(*) n FROM model_configs").get().n;
    expect(() => createModelConfig({ name: "test", baseUrl, apiKey: "test", model: "test" })).toThrow();
    expect(db.prepare("SELECT COUNT(*) n FROM model_configs").get().n).toBe(before);
  });
  it("rejects browser-bypassing invalid requests with 400 and no config change", async () => {
    const server = createApp().listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const before = revision();
    try {
      for (const [route, body] of [["/api/sections/refund/fields", { key: "valid", label: "field", type: "string", isEnabled: "false" }], ["/api/sections", { name: "section", prompt: "", outputSchema: [null] }]]) {
        const result = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        expect(result.status).toBe(400); expect((await result.json()).success).toBe(false);
      }
      expect(revision()).toBe(before);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
