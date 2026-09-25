import { createFieldRun } from "../field-run-service";
import { extractKnowledgeValue } from "../knowledge/knowledge-extract-service";
import { dependencyValues } from "./support";
import { registerFieldExecutionHandler } from "./registry";

registerFieldExecutionHandler({
  type: "knowledge_extract",
  async run({ recordId, record, field, configVersion, context }) {
    const dependencies = dependencyValues(field, record.sourceFields, context);
    const started = Date.now();
    const matchFieldKey = field.matchFieldKey!;
    try {
      const result = extractKnowledgeValue({
        recordId,
        sectionId: field.sectionId,
        matchFieldKey,
        matchFieldId: configVersion.fieldsSnapshot.find((candidate) => candidate.key === matchFieldKey)?.id,
        matchValue: typeof context[matchFieldKey] === "string"
          ? context[matchFieldKey] as string
          : "",
        knowledgeColumn: field.knowledgeColumn!,
        outputKey: field.key,
      });
      const run = createFieldRun({
        recordId,
        fieldId: field.id,
        status: "completed",
        result,
        dependencies,
        promptSnapshot: field.prompt,
        fieldSnapshot: field,
        modelConfigSnapshot: {},
        durationMs: Date.now() - started,
      });
      return { result, status: "completed" as const, run };
    } catch (error) {
      const message = error instanceof Error ? error.message : "知识提取失败";
      const run = createFieldRun({
        recordId,
        fieldId: field.id,
        status: "failed",
        result: {},
        dependencies,
        promptSnapshot: field.prompt,
        fieldSnapshot: field,
        modelConfigSnapshot: {},
        errorMessage: message,
        durationMs: Date.now() - started,
      });
      return { result: {}, status: "failed" as const, errorMessage: message, run };
    }
  },
});
