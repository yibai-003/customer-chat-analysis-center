import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, initDb } from "../../db/client";
import { applySectionConfigVersions } from "../../db/migrations/018-section-config-versions";
import { upsertField } from "../field-config-service";
import { analyzeField, analyzeRecordFields } from "../field-analysis-service";
import { captureHotTopicQuestions, parseHotTopicQuestions, setHotTopicKnowledgeSync } from "./hot-topic-service";
import { getKnowledgeBase, listKnowledgeItems, upsertKnowledgeBase, upsertKnowledgeItem } from "./knowledge-repository";
import { callVisionModel } from "../../ai/openai-compatible-client";
import { callModelPool } from "../model-pool-service";
import { HOT_TOPIC_BASE_ID, HOT_TOPIC_PROMPT } from "../../../shared/hot-topic";
import { withAnalysisCancellation, cancelAnalysis } from "../analysis-cancellation";
import type { AnalysisField, ModelConfig, ModelRouteResult } from "../../../shared/types";
import { createDraftVersion, publishSectionVersion } from "../section-config-version-service";

vi.mock("../../ai/openai-compatible-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ai/openai-compatible-client")>();
  return { ...actual, callVisionModel: vi.fn() };
});
vi.mock("../model-pool-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model-pool-service")>();
  return { ...actual, callModelPool: vi.fn() };
});

let field: AnalysisField;
const evidence = "客户问什么时候寄出，能不能开票";
const dependencies = { 截图解析: evidence };
function response(value: unknown) { return { content: JSON.stringify(value), raw: JSON.stringify(value), usage: {} }; }
function extract(question = "订单何时发货？") { return response({ questions: [{ question, evidence }] }); }
function capture(recordId = "record-one") { return captureHotTopicQuestions({ field, recordId, dependencies }); }
function existing(question: string, enabled = true, sectionId = "hot-topic") {
  const base = upsertKnowledgeBase({ id: `existing-${sectionId}`, name: "已有问题", sectionId,
    originalFilename: "questions.xlsx", columns: [{ name: "问题", roles: ["result", "search"] }], isEnabled: true });
  return upsertKnowledgeItem({ id: `item-${sectionId}`, knowledgeBaseId: base.id, values: { 问题: question }, isEnabled: enabled });
}

function routedModel(id: string): ModelConfig {
  return {
    id,
    name: `${id} name`,
    baseUrl: `https://${id}.example/v1`,
    maskedApiKey: "****",
    model: `${id}-model`,
    supportsVision: false,
    temperature: 0,
    maxTokens: 200,
    isDefault: false,
    purpose: "text",
    isPurposeDefault: true,
    isEnabled: true,
    poolEnabled: true,
    billingMode: "free",
    qualityTier: "A",
    priority: 100,
    thinkingMode: false,
    memberType: "general",
    quotaTotalTokens: 1000,
    quotaUsedTokens: 0,
    quotaSafetyRatio: 0.95,
    consecutiveFailures: 0,
    capabilityEligible: true,
    quotaBlocked: false,
  };
}

function routedResponse(
  value: unknown,
  modelId = "test-text",
  usage: ModelRouteResult["usage"] = {},
  raw = JSON.stringify(value),
  attempts?: ModelRouteResult["attempts"],
): ModelRouteResult {
  const model = routedModel(modelId);
  return {
    content: JSON.stringify(value),
    raw,
    usage,
    model,
    attempts: attempts ?? [{
      modelConfigId: model.id,
      model: model.model,
      status: "success",
      durationMs: 7,
    }],
  };
}

beforeEach(() => {
  initDb();
  db.exec(`
    DELETE FROM jobs;
    DROP TRIGGER IF EXISTS section_versions_immutable_delete;
    DROP TRIGGER IF EXISTS section_versions_restrict_section_delete;
    DELETE FROM analysis_section_versions;
    DELETE FROM knowledge_item_fts;
    DELETE FROM analysis_sections;
  `);
  initDb();
  applySectionConfigVersions(db);
  db.prepare("DELETE FROM analysis_fields WHERE section_id='hot-topic'").run();
  db.prepare("UPDATE analysis_sections SET source_fields_json=? WHERE id='hot-topic'").run(JSON.stringify(["截图解析"]));
  field = upsertField({ sectionId: "hot-topic", key: "高频问题", label: "高频问题", type: "string", prompt: HOT_TOPIC_PROMPT,
    executionType: "ai", imageEnabled: false, dependsOn: ["截图解析"], knowledgeSyncEnabled: true });
  publishSectionVersion(createDraftVersion("hot-topic").id);
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO jobs(id,original_filename,source_path,status,created_at,updated_at)
    VALUES ('job-one','test.xlsx','test.xlsx','ready',?,?)`).run(timestamp, timestamp);
  for (const id of ["record-one", "record-two"]) db.prepare(`INSERT INTO records
    (id,job_id,sheet_name,row_number,anchor_json,source_fields_json,image_path,status,review_status,created_at,updated_at)
    VALUES (?,'job-one','Sheet1',2,'{}',?,'','pending','pending',?,?)`).run(id, JSON.stringify(dependencies), timestamp, timestamp);
  vi.mocked(callVisionModel).mockReset();
  vi.mocked(callModelPool).mockReset();
  vi.mocked(callModelPool).mockImplementation(async (messages) => {
    const model = routedModel("test-text");
    const response = await callVisionModel(model as never, messages, { attempts: 1 });
    return {
      ...response,
      model,
      attempts: [{
        modelConfigId: model.id,
        model: model.model,
        status: "success",
        durationMs: 1,
      }],
    };
  });
  setHotTopicKnowledgeSync(undefined);
});

describe("hot-topic capture", () => {
  it("records each logical ask route independently and aggregates usage once", async () => {
    const item = existing("开票咨询");
    vi.mocked(callModelPool)
      .mockResolvedValueOnce(routedResponse(
        { questions: [{ question: "可以提供发票吗？", evidence }] },
        "extractor",
        { prompt_tokens: 3, completion_tokens: 2 },
        "extract-raw",
      ))
      .mockResolvedValueOnce(routedResponse(
        { decision: "match", itemId: item.id },
        "matcher",
        { prompt_tokens: 5, completion_tokens: 7 },
        "match-raw",
      ));

    const run = await capture();

    expect(run.status).toBe("completed");
    expect(callModelPool).toHaveBeenCalledTimes(2);
    expect(vi.mocked(callModelPool).mock.calls.map(([, options]) => options)).toEqual([
      {
        purpose: "text",
        recordId: "record-one",
        fieldId: field.id,
        operation: "hot_topic_capture",
      },
      {
        purpose: "text",
        recordId: "record-one",
        fieldId: field.id,
        operation: "hot_topic_capture",
      },
    ]);
    expect(run.modelConfigSnapshot).toEqual({
      purpose: "text",
      models: [
        {
          id: "extractor",
          name: "extractor name",
          model: "extractor-model",
          purpose: "text",
          attempts: [{
            modelConfigId: "extractor",
            model: "extractor-model",
            status: "success",
            durationMs: 7,
          }],
        },
        {
          id: "matcher",
          name: "matcher name",
          model: "matcher-model",
          purpose: "text",
          attempts: [{
            modelConfigId: "matcher",
            model: "matcher-model",
            status: "success",
            durationMs: 7,
          }],
        },
      ],
    });
    expect(JSON.parse(run.rawResponse ?? "[]")).toEqual([
      {
        request: { fieldPrompt: field.prompt, dependencies },
        response: "extract-raw",
      },
      {
        request: expect.objectContaining({
          question: { question: "可以提供发票吗？", evidence },
        }),
        response: "match-raw",
      },
    ]);
    expect(run.inputTokens).toBe(8);
    expect(run.outputTokens).toBe(9);
  });

  it("writes one knowledge item after a 429 failover succeeds", async () => {
    vi.mocked(callModelPool).mockResolvedValueOnce(routedResponse(
      { questions: [{ question: "订单何时发货？", evidence }] },
      "second",
      { prompt_tokens: 4, completion_tokens: 3 },
      "second-raw",
      [
        {
          modelConfigId: "first",
          model: "first-model",
          status: "switched",
          errorCode: "rate_limit",
          durationMs: 5,
        },
        {
          modelConfigId: "second",
          model: "second-model",
          status: "success",
          durationMs: 6,
        },
      ],
    ));

    const run = await capture();

    expect(run.status).toBe("completed");
    expect(callModelPool).toHaveBeenCalledTimes(1);
    expect(listKnowledgeItems(HOT_TOPIC_BASE_ID).items).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) n FROM hot_topic_record_questions").get()).toEqual({ n: 1 });
    expect(run.modelConfigSnapshot).toMatchObject({
      models: [{
        id: "second",
        attempts: [
          { modelConfigId: "first", status: "switched", errorCode: "rate_limit" },
          { modelConfigId: "second", status: "success" },
        ],
      }],
    });
  });

  it("records a permanent pool error as a failed capture", async () => {
    vi.mocked(callModelPool).mockRejectedValueOnce(new Error("401 unauthorized"));

    expect((await capture()).status).toBe("failed");
    expect(callModelPool).toHaveBeenCalledTimes(1);
    expect(callVisionModel).not.toHaveBeenCalled();
  });

  it.each(["401 unauthorized", "CERT_HAS_EXPIRED", "network error", "429 rate limit", "invalid protocol"])("propagates %s as failed through record aggregation without new knowledge", async message => {
    vi.mocked(callVisionModel).mockRejectedValue(new Error(message));
    const result = await analyzeRecordFields("record-one", "hot-topic");
    expect(result.failed).toBe(1); expect(result.needsReview).toBe(0);
    expect(db.prepare("SELECT status FROM records WHERE id='record-one'").get().status).toBe("failed");
    expect(db.prepare("SELECT status FROM analysis_field_runs WHERE record_id='record-one'").get().status).toBe("failed");
    expect(getKnowledgeBase(HOT_TOPIC_BASE_ID)).toBeUndefined();
  });
  it("keeps successful analysis completed when only catalog export fails", async () => {
    const exportSnapshot = vi.fn(() => { throw new Error("snapshot unavailable"); });
    setHotTopicKnowledgeSync({ assertUnchanged: vi.fn(), export: exportSnapshot } as any);
    vi.mocked(callVisionModel).mockResolvedValueOnce(extract());
    const run = await capture();
    expect(run.status).toBe("completed");
    expect(db.prepare("SELECT status FROM analysis_field_runs WHERE id=?").get(run.id).status).toBe("completed");
    expect(listKnowledgeItems(HOT_TOPIC_BASE_ID).items).toHaveLength(1);
    expect(exportSnapshot).toHaveBeenCalledTimes(1);
    expect(callVisionModel).toHaveBeenCalledTimes(1);
    const state = db.prepare("SELECT revision,exported_revision FROM knowledge_sync_outbox").get();
    expect(state.revision).toBeGreaterThan(state.exported_revision);
  });
  it("cancels queued capture immediately and prevents late extraction from creating knowledge", async () => {
    let deliver!: (value: ReturnType<typeof extract>) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(callVisionModel).mockImplementationOnce(() => { started(); return new Promise(resolve => { deliver = resolve; }); });
    const first = withAnalysisCancellation("first-job", "one", () => capture());
    const firstCheck = expect(first).rejects.toThrow("取消");
    await entered;
    const queued = withAnalysisCancellation("queued-job", "two", () => capture("record-two"));
    const queuedCheck = expect(queued).rejects.toThrow("取消");
    cancelAnalysis("queued-job", "two"); await queuedCheck;
    cancelAnalysis("first-job", "one"); deliver(extract()); await firstCheck;
    await new Promise(resolve => setImmediate(resolve));
    expect(callVisionModel).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) n FROM analysis_field_runs").get().n).toBe(0);
    expect(getKnowledgeBase(HOT_TOPIC_BASE_ID)).toBeUndefined();
  });
  it("captures two independent questions and preserves evidence in run snapshots", async () => {
    vi.mocked(callVisionModel).mockResolvedValueOnce(response({ questions: [
      { question: "订单何时发货？", evidence }, { question: "可以开发票吗？", evidence },
    ] })).mockResolvedValueOnce(response({ decision: "new", itemId: "" }));
    const run = await capture();
    expect(run.status).toBe("completed");
    expect(run.result["高频问题"]).toBe("订单何时发货？\n可以开发票吗？");
    expect(run.evidence).toContain(evidence);
    expect(listKnowledgeItems(HOT_TOPIC_BASE_ID).items).toHaveLength(2);
    expect(listKnowledgeItems(HOT_TOPIC_BASE_ID).items.every((item) => item.occurrenceCount === 1)).toBe(true);
    const snapshot = structuredClone(run.result);
    const item = listKnowledgeItems(HOT_TOPIC_BASE_ID).items[0];
    upsertKnowledgeItem({ ...item, values: { 标准问题: "人工调整后的词条" } });
    expect(JSON.parse(db.prepare("SELECT result_json FROM analysis_field_runs WHERE id=?").get(run.id).result_json)).toEqual(snapshot);
  });

  it("semantically reuses an imported question even without a shared trigram", async () => {
    const item = existing("开票咨询");
    vi.mocked(callVisionModel).mockResolvedValueOnce(extract("可以提供发票吗？"))
      .mockResolvedValueOnce(response({ decision: "match", itemId: item.id }));
    const run = await capture();
    expect(run.status).toBe("completed");
    expect(run.result["高频问题"]).toBe("开票咨询");
    expect(getKnowledgeBase(HOT_TOPIC_BASE_ID)).toBeUndefined();
    expect(listKnowledgeItems(item.knowledgeBaseId).items[0].occurrenceCount).toBe(1);
  });

  it("serializes concurrent records and keeps retries idempotent", async () => {
    vi.mocked(callVisionModel).mockResolvedValue(extract());
    const runs = await Promise.all([capture(), capture("record-two"), capture()]);
    expect(runs.every((run) => run.status === "completed")).toBe(true);
    const page = listKnowledgeItems(HOT_TOPIC_BASE_ID);
    expect(page.total).toBe(1);
    expect(page.items[0].occurrenceCount).toBe(2);
    expect(callVisionModel).toHaveBeenCalledTimes(3);
  });

  it("allows no question and removes the current record's previous association on successful reanalysis", async () => {
    vi.mocked(callVisionModel).mockResolvedValueOnce(extract()).mockResolvedValueOnce(response({ questions: [] }));
    await capture();
    expect((await capture()).result["高频问题"]).toBe("");
    expect(listKnowledgeItems(HOT_TOPIC_BASE_ID).items[0].occurrenceCount).toBe(0);
  });

  it("deduplicates questions from one record by semantic match", async () => {
    vi.mocked(callVisionModel).mockResolvedValueOnce(response({ questions: [
      { question: "订单何时发货？", evidence }, { question: "什么时候寄出商品？", evidence },
    ] })).mockImplementationOnce(async (_model, messages) => {
      const data = JSON.parse((messages[1] as { content: string }).content);
      return response({ decision: "match", itemId: data.candidates[0].itemId });
    });
    expect((await capture()).result["高频问题"]).toBe("订单何时发货？");
    expect(listKnowledgeItems(HOT_TOPIC_BASE_ID).total).toBe(1);
  });

  it.each(["invalid", "review", "network"])("does not write on %s match output", async (kind) => {
    existing("开票咨询");
    vi.mocked(callVisionModel).mockResolvedValueOnce(extract());
    if (kind === "network") vi.mocked(callVisionModel).mockRejectedValueOnce(new Error("model unavailable"));
    else vi.mocked(callVisionModel).mockResolvedValueOnce(response({ decision: kind === "invalid" ? "match" : "review", itemId: kind === "invalid" ? "forged-id" : "" }));
    expect((await capture()).status).toBe(kind === "review" ? "needs_review" : "failed");
    expect(getKnowledgeBase(HOT_TOPIC_BASE_ID)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) n FROM hot_topic_record_questions").get().n).toBe(0);
  });

  it("rejects an oversized or ungrounded extraction before any write", async () => {
    field = upsertField({ ...field, knowledgeCaptureLimit: 1 });
    vi.mocked(callVisionModel).mockResolvedValueOnce(response({ questions: [
      { question: "订单何时发货？", evidence }, { question: "可以开发票吗？", evidence },
    ] })).mockResolvedValueOnce(response({ questions: [{ question: "会不会漏水？", evidence: "不存在的原文" }] }));
    expect((await capture()).status).toBe("failed");
    expect((await capture()).status).toBe("needs_review");
    expect(getKnowledgeBase(HOT_TOPIC_BASE_ID)).toBeUndefined();
  });

  it("keeps stopped dictionaries and items stopped", async () => {
    vi.mocked(callVisionModel).mockResolvedValue(extract());
    await capture();
    const base = getKnowledgeBase(HOT_TOPIC_BASE_ID)!;
    upsertKnowledgeBase({ ...base, isEnabled: false });
    expect((await capture()).status).toBe("needs_review");
    upsertKnowledgeBase({ ...base, isEnabled: true });
    const item = listKnowledgeItems(base.id).items[0];
    upsertKnowledgeItem({ ...item, isEnabled: false });
    expect((await capture()).status).toBe("needs_review");
    expect(listKnowledgeItems(base.id).items[0].isEnabled).toBe(false);
    expect(listKnowledgeItems(base.id).total).toBe(1);
  });

  it("does not use another section's question", async () => {
    existing("订单何时发货？", true, "refund");
    vi.mocked(callVisionModel).mockResolvedValue(extract());
    expect((await capture()).status).toBe("completed");
    expect(getKnowledgeBase(HOT_TOPIC_BASE_ID)?.itemCount).toBe(1);
  });

  it("rolls back new items and associations if saving the run fails", async () => {
    vi.mocked(callVisionModel).mockResolvedValue(extract());
    db.exec(`CREATE TEMP TRIGGER reject_hot_run BEFORE INSERT ON analysis_field_runs
      WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;`);
    try { expect((await capture()).status).toBe("failed"); }
    finally { db.exec("DROP TRIGGER reject_hot_run"); }
    expect(getKnowledgeBase(HOT_TOPIC_BASE_ID)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) n FROM hot_topic_record_questions").get().n).toBe(0);
  });

  it("rejects a knowledge edit while a model decision is in flight", async () => {
    const item = existing("订单何时发货？");
    vi.mocked(callVisionModel).mockResolvedValueOnce(extract("什么时候寄出？"))
      .mockImplementationOnce(async () => {
        upsertKnowledgeItem({ ...item, isEnabled: false });
        return response({ decision: "match", itemId: item.id });
      });
    expect((await capture()).status).toBe("needs_review");
    expect(db.prepare("SELECT COUNT(*) n FROM hot_topic_record_questions").get().n).toBe(0);
  });

  it("uses generated dependencies ahead of empty Excel output columns in batch and individual retry", async () => {
    upsertField({ sectionId: "hot-topic", key: "截图解析", label: "截图解析", type: "string", prompt: "解析", imageEnabled: false });
    publishSectionVersion(createDraftVersion("hot-topic").id);
    db.prepare("UPDATE records SET source_fields_json=?").run(JSON.stringify({ 截图解析: "" }));
    vi.mocked(callVisionModel).mockResolvedValueOnce(response({ 截图解析: evidence }))
      .mockResolvedValueOnce(extract()).mockResolvedValueOnce(extract());
    const result = await analyzeRecordFields("record-one", "hot-topic");
    expect(result.completed).toBe(2);
    const retry = await analyzeField("record-one", "hot-topic", "高频问题");
    expect(retry.status).toBe("completed");
    expect(retry.dependencies["截图解析"]).toBe(evidence);
    expect(listKnowledgeItems(HOT_TOPIC_BASE_ID).items[0].occurrenceCount).toBe(1);
  });
});

describe("question parser", () => {
  it("rejects identifiers and accepts empty lists", () => {
    expect(() => parseHotTopicQuestions(extract("订单123456789012何时发货？").content, 2, dependencies)).toThrow();
    expect(parseHotTopicQuestions('{"questions":[]}', 2, dependencies)).toEqual([]);
  });
});
