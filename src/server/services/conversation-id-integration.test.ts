import { beforeAll, describe, expect, it } from "vitest";
import { initDb } from "../db/client";
import {
  addRecords,
  createJob,
  createPlatform,
  getRecord,
  listRecords,
  upsertSection,
  updateRecord,
} from "../db/repositories";
import { upsertField } from "./field-config-service";
import {
  activateSectionVersion,
  createDraftVersion,
  publishSectionVersion,
} from "./section-config-version-service";

beforeAll(() => initDb());

function addSingleRecord(jobId: string) {
  addRecords(jobId, [{
    sheetName: "Sheet1",
    rowNumber: 2,
    anchor: {},
    sourceFields: {},
    imagePath: `${jobId}.png`,
  }]);
  return listRecords(jobId)[0];
}

describe("conversation ID integration", () => {
  it("keeps one persisted ID across competing final-state transitions", async () => {
    const platform = createPlatform({
      name: "竞争派发平台",
      code: `COMPETE${Date.now()}`,
    });
    const job = createJob("competing.xlsx", "competing.xlsx", undefined, platform);
    const record = addSingleRecord(job.id);
    let secondRandomCalls = 0;

    const [completed, needsReview] = await Promise.all([
      Promise.resolve().then(() => updateRecord(record.id, { status: "completed" }, {
        now: () => new Date("2026-09-22T04:00:00.000Z"),
        randomCode: () => "FIRST1",
      })),
      Promise.resolve().then(() => updateRecord(record.id, { status: "needs_review" }, {
        now: () => new Date("2026-09-23T04:00:00.000Z"),
        randomCode: () => {
          secondRandomCalls += 1;
          return "SECOND";
        },
      })),
    ]);

    expect(completed.conversationId).toBe(needsReview.conversationId);
    expect(getRecord(record.id)?.conversationId).toBe(completed.conversationId);
    expect(secondRandomCalls).toBe(0);
  });

  it("does not mutate a historical record ID when the current section version changes", () => {
    const sectionId = `conversation-version-${Date.now()}`;
    upsertSection({
      id: sectionId,
      name: "会话版本稳定板块",
      prompt: "分析会话",
    });
    upsertField({
      sectionId,
      key: "result",
      label: "结果",
      type: "string",
      prompt: "输出结果",
      outputColumn: "结果",
      dependsOn: [],
    });
    const currentVersion = publishSectionVersion(createDraftVersion(sectionId).id);
    const platform = createPlatform({
      name: "版本稳定平台",
      code: `VERSIONSTABLE${Date.now()}`,
    });
    const job = createJob(
      "version-stable.xlsx",
      "version-stable.xlsx",
      { id: sectionId, name: "会话版本稳定板块" },
      platform,
    );
    const record = addSingleRecord(job.id);
    const assigned = updateRecord(record.id, { status: "completed" }, {
      now: () => new Date("2026-09-22T04:00:00.000Z"),
      randomCode: () => "VERSN1",
    });

    const nextDraft = createDraftVersion(sectionId);
    publishSectionVersion(nextDraft.id);
    expect(getRecord(record.id)?.conversationId).toBe(assigned.conversationId);

    activateSectionVersion(currentVersion.id);
    expect(getRecord(record.id)).toMatchObject({
      conversationId: assigned.conversationId,
      conversationIdAssignedAt: assigned.conversationIdAssignedAt,
    });
  });
});
