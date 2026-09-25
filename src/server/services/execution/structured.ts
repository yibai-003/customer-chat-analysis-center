import { assertAnalysisActive } from "../analysis-cancellation";
import { classifyModelError } from "../../ai/openai-compatible-client";
import { db } from "../../db/client";
import { createFieldRun } from "../field-run-service";
import { callModelPool } from "../model-pool-service";
import {
  dependencyValues,
  failedRouteSnapshot,
  imageDataUrl,
  routedModelSnapshot,
} from "./support";
import { type FieldExecutionHandler } from "./registry";
import type {
  AnalysisExecutionType,
  AnalysisField,
  SectionConfigVersion,
} from "../../../shared/types";

export interface StructuredInput {
  recordId: string;
  field: AnalysisField;
  configVersion: SectionConfigVersion;
  dependencies: Record<string, unknown>;
  sourceFields: Record<string, string>;
  imageDataUrl: string;
}

export interface StructuredStatus {
  status: "completed" | "needs_review";
  errorMessage?: string;
}

export interface StructuredFieldDefinition<TSource = unknown, TParsed = unknown> {
  key: string;
  prepare(input: StructuredInput): TSource;
  buildMessages(input: StructuredInput, source: TSource): unknown[];
  parse(raw: string, source: TSource): TParsed;
  derive(parsed: TParsed): Record<string, unknown>;
  status(parsed: TParsed): StructuredStatus;
  evidence(parsed: TParsed): string;
  persist?(input: {
    recordId: string;
    fieldId: string;
    parsed: TParsed;
    knowledgeSyncEnabled: boolean;
    configVersion: SectionConfigVersion;
  }): void;
}

function parsedFromContext<TParsed>(key: string, context: Record<string, unknown>): TParsed {
  const value = context[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key}结果不存在或格式无效`);
  }
  return value as TParsed;
}

export function createStructuredAnalysisHandler<TSource, TParsed>(
  type: AnalysisExecutionType,
  definition: StructuredFieldDefinition<TSource, TParsed>,
  options: { purpose?: "vision" | "text" } = {},
): FieldExecutionHandler {
  return {
    type,
    async run({ recordId, field, configVersion, record, context, image }) {
      const input: StructuredInput = {
        recordId,
        field,
        configVersion,
        dependencies: dependencyValues(field, record.sourceFields, context),
        sourceFields: record.sourceFields,
        imageDataUrl: image ? imageDataUrl(record.imagePath, image) : "",
      };
      const started = Date.now();
      let routed: Awaited<ReturnType<typeof callModelPool>> | undefined;
      let invalidResponse: string | undefined;
      try {
        const source = definition.prepare(input);
        const messages = definition.buildMessages(input, source);
        routed = await callModelPool(messages, {
          purpose: options.purpose ?? "text",
          recordId,
          fieldId: field.id,
          operation: field.executionType ?? type,
          validate: (content) => {
            invalidResponse = content;
            try {
              definition.parse(content, source);
              invalidResponse = undefined;
              return { valid: true };
            } catch {
              return { valid: false };
            }
          },
        });
        assertAnalysisActive();
        const parsed = definition.parse(routed.content, source);
        const result = { [field.key]: parsed };
        const { status, errorMessage } = definition.status(parsed);
        const selectedRoute = routed;
        const run = db.transaction(() => {
          const created = createFieldRun({
            recordId,
            fieldId: field.id,
            status,
            result,
            evidence: definition.evidence(parsed),
            dependencies: input.dependencies,
            promptSnapshot: field.prompt,
            fieldSnapshot: field,
            modelConfigSnapshot: routedModelSnapshot(selectedRoute),
            rawResponse: selectedRoute.raw,
            errorMessage,
            durationMs: Date.now() - started,
            usage: selectedRoute.usage,
          });
          definition.persist?.({
            recordId,
            fieldId: field.id,
            parsed,
            knowledgeSyncEnabled: Boolean(field.knowledgeSyncEnabled),
            configVersion,
          });
          return created;
        })();
        return { result, status, errorMessage, run };
      } catch (error) {
        assertAnalysisActive();
        const message = classifyModelError(error).message;
        const run = createFieldRun({
          recordId,
          fieldId: field.id,
          status: "failed",
          result: {},
          dependencies: input.dependencies,
          promptSnapshot: field.prompt,
          fieldSnapshot: field,
          modelConfigSnapshot: routed ? routedModelSnapshot(routed) : failedRouteSnapshot(error),
          rawResponse: routed?.raw ?? invalidResponse,
          errorMessage: message,
          durationMs: Date.now() - started,
        });
        return { result: {}, status: "failed" as const, errorMessage: message, run };
      }
    },
  };
}

export function createStructuredDeriveHandler<TSource, TParsed>(
  type: AnalysisExecutionType,
  definition: StructuredFieldDefinition<TSource, TParsed>,
  options: { modelConfigSnapshot?: unknown } = {},
): FieldExecutionHandler {
  return {
    type,
    async run({ recordId, field, configVersion, record, context }) {
      const input: StructuredInput = {
        recordId,
        field,
        configVersion,
        dependencies: dependencyValues(field, record.sourceFields, context),
        sourceFields: record.sourceFields,
        imageDataUrl: "",
      };
      const started = Date.now();
      const parsed = parsedFromContext<TParsed>(definition.key, context);
      const derived = definition.derive(parsed);
      const result = { [field.key]: derived[field.key] ?? "" };
      const { status, errorMessage } = definition.status(parsed);
      const run = createFieldRun({
        recordId,
        fieldId: field.id,
        status,
        result,
        evidence: definition.evidence(parsed),
        dependencies: input.dependencies,
        promptSnapshot: field.prompt,
        fieldSnapshot: field,
        modelConfigSnapshot: options.modelConfigSnapshot ?? {},
        errorMessage,
        durationMs: Date.now() - started,
      });
      return { result, status, errorMessage, run };
    },
  };
}
