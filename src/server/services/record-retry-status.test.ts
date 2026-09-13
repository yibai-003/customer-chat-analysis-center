import { beforeAll, describe, expect, it, vi } from "vitest";
import { db, initDb } from "../db/client";
import { addRecords, createJob, getRecord, listRecords, upsertSection } from "../db/repositories";
import { upsertField } from "./field-config-service";
import { createFieldRun } from "./field-run-service";
import { analyzeField } from "./field-analysis-service";
vi.mock("./model-config-service", () => ({ getModelsForPurpose: () => [{ name: "text", model: "test" }] }));
vi.mock("../ai/openai-compatible-client", () => ({ callVisionModel: async () => ({ content: '{"first":"ok"}', raw: "{}", usage: {} }), classifyModelError: (e: Error) => ({ message: e.message }) }));
beforeAll(() => initDb());
describe("field retry status", () => {
  it.each(["failed", "needs_review", "pending"] as const)("does not hide a sibling field that is %s", async status => {
    const sectionId = `retry-${status}`;
    upsertSection({ id: sectionId, name: sectionId, prompt: "", outputSchema: [] });
    const first = upsertField({ sectionId, key: "first", label: "first", type: "string", imageEnabled: false });
    const second = upsertField({ sectionId, key: "second", label: "second", type: "string", imageEnabled: false });
    const job = createJob("retry.xlsx", "retry.xlsx", { id: sectionId, name: sectionId });
    addRecords(job.id, [{ sheetName: "s", rowNumber: 1, anchor: {}, sourceFields: {}, imagePath: "unused" }]);
    const record = listRecords(job.id)[0];
    createFieldRun({ recordId: record.id, fieldId: first.id, status: "failed" });
    if (status !== "pending") createFieldRun({ recordId: record.id, fieldId: second.id, status });
    expect((await analyzeField(record.id, sectionId, "first")).status).toBe("completed");
    expect(getRecord(record.id)?.status).toBe(status);
    expect(db.prepare("SELECT COUNT(*) n FROM analysis_field_runs WHERE field_id=?").get(first.id).n).toBe(2);
  });
});
