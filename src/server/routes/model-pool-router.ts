import express from "express";
import { z, ZodError } from "zod";
import {
  createModelProvider,
  deleteModelProvider,
  listModelProviders,
  safeBaseUrlSchema,
  testModelProvider,
  updateModelProvider,
} from "../services/model-provider-service";
import {
  getModelPoolSettings,
  getPoolSummary,
  installQianwenFreePool,
  listModelUsageEvents,
  listPoolMembers,
  POOL_REMOVAL_REASONS,
  removePoolMembers,
  restorePoolMembers,
  updateModelPoolSettings,
  updatePoolMember,
  verifyPoolMembers,
} from "../services/model-pool-admin-service";
import { requireCapability } from "../auth/capabilities";
import { auditRequest } from "../auth/audit";
import { createRouteResponders } from "../http/route-response";

const idSchema = z.string().min(1).max(200);

const providerCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  baseUrl: safeBaseUrlSchema,
  apiKey: z.string().min(1).max(4096),
  isEnabled: z.boolean().optional(),
}).strict();

const providerPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  baseUrl: safeBaseUrlSchema.optional(),
  apiKey: z.string().min(1).max(4096).optional(),
  isEnabled: z.boolean().optional(),
}).strict();

const poolListQuerySchema = z.object({
  purpose: z.enum(["vision", "text"]).optional(),
}).strict();

const poolMemberPatchSchema = z.object({
  isEnabled: z.boolean().optional(),
  poolEnabled: z.boolean().optional(),
  billingMode: z.enum(["free", "paid"]).optional(),
  qualityTier: z.enum(["A", "B", "C"]).optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  quotaTotalTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  quotaUsedTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  quotaExpiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  quotaSafetyRatio: z.number().positive().max(1).optional(),
}).strict();

const verificationSchema = z.object({
  ids: z.array(idSchema).min(1).max(50),
  enablePassed: z.boolean().optional().default(false),
}).strict();

const removalSchema = z.object({
  ids: z.array(idSchema).min(1).max(50),
  reason: z.enum(POOL_REMOVAL_REASONS),
  note: z.string().max(200).optional(),
}).strict();

const memberIdsSchema = z.object({
  ids: z.array(idSchema).min(1).max(50),
}).strict();

const settingsPatchSchema = z.object({
  paidDailyTokenLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  paidMonthlyTokenLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  capabilityTtlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

const usageFilterSchema = z.object({
  purpose: z.enum(["vision", "text"]).optional(),
  eventType: z.enum([
    "success",
    "failure",
    "switch",
    "quota_exhausted",
    "cooldown",
    "paid_blocked",
    "usage_unknown",
  ]).optional(),
  modelConfigId: idSchema.optional(),
  cursor: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
}).strict();

function routeId(value: string | string[]) {
  return idSchema.parse(Array.isArray(value) ? value[0] : value);
}

function errorStatus(error: unknown) {
  if (error instanceof ZodError) return 400;
  if (
    error instanceof Error
    && (error.message === "模型供应商不存在" || error.message === "模型池成员不存在")
  ) {
    return 404;
  }
  if (error instanceof Error && error.message === "模型供应商仍被模型配置引用") return 409;
  return 400;
}

export function createModelPoolRouter(): express.Router {
  const router = express.Router();
  const canReadPool = requireCapability("config:manage", "config.pool_read", "model_pool");
  const canCreateProvider = requireCapability("config:manage", "pool.create_provider", "model_provider");
  const canUpdateProvider = requireCapability("config:manage", "pool.update_provider", "model_provider");
  const canTestProvider = requireCapability("config:manage", "pool.test_provider", "model_provider");
  const canUpdateMember = requireCapability("config:manage", "pool.update_member", "model_pool_member");
  const canInstallPreset = requireCapability("config:manage", "pool.install_preset", "model_pool");
  const canVerify = requireCapability("config:manage", "pool.verify", "model_pool_member");
  const canRemove = requireCapability("config:manage", "pool.remove", "model_pool_member");
  const canRestore = requireCapability("config:manage", "pool.restore", "model_pool_member");
  const canUpdateSettings = requireCapability("config:manage", "pool.update_settings", "model_pool");
  const { ok, fail } = createRouteResponders({
    resolveStatus: (error, fallbackStatus) => (
      fallbackStatus === 400 ? errorStatus(error) : fallbackStatus
    ),
    resolveMessage: (error) => (
      error instanceof ZodError
        ? "请求参数无效"
        : error instanceof Error
          ? error.message
          : String(error || "请求失败")
    ),
  });

  router.get("/model-providers", canReadPool, (_req, res) => ok(res, listModelProviders()));

  router.post("/model-providers", canCreateProvider, (req, res) => {
    try {
      const provider = createModelProvider(providerCreateSchema.parse(req.body));
      auditRequest(req, { action: "pool.create_provider", targetType: "model_provider", targetId: provider.id, metadata: { name: provider.name } });
      return ok(res, provider);
    } catch (error) {
      return fail(res, error);
    }
  });

  router.patch("/model-providers/:id", canUpdateProvider, (req, res) => {
    try {
      const input = providerPatchSchema.parse(req.body);
      const provider = updateModelProvider(routeId(req.params.id), input);
      auditRequest(req, {
        action: "pool.update_provider",
        targetType: "model_provider",
        targetId: provider.id,
        metadata: { name: provider.name, fields: Object.keys(input) },
      });
      return ok(res, provider);
    } catch (error) {
      return fail(res, error);
    }
  });

  router.delete("/model-providers/:id", canUpdateProvider, (req, res) => {
    try {
      const id = routeId(req.params.id);
      deleteModelProvider(id);
      auditRequest(req, {
        action: "pool.delete_provider",
        targetType: "model_provider",
        targetId: id,
      });
      return ok(res, true);
    } catch (error) {
      return fail(res, error);
    }
  });

  router.post("/model-providers/:id/test", canTestProvider, async (req, res) => {
    try {
      const result = await testModelProvider(routeId(req.params.id));
      auditRequest(req, { action: "pool.test_provider", targetType: "model_provider", targetId: String(req.params.id) });
      return ok(res, result);
    } catch (error) {
      return fail(res, error);
    }
  });

  router.get("/model-pools", canReadPool, (req, res) => {
    try {
      const query = poolListQuerySchema.parse(req.query);
      return ok(res, {
        members: listPoolMembers(query.purpose),
        summary: getPoolSummary(),
      });
    } catch (error) {
      return fail(res, error);
    }
  });

  router.patch("/model-pool-members/:id", canUpdateMember, (req, res) => {
    try {
      const input = poolMemberPatchSchema.parse(req.body);
      const member = updatePoolMember(routeId(req.params.id), input);
      auditRequest(req, {
        action: "pool.update_member",
        targetType: "model_pool_member",
        targetId: String(req.params.id),
        metadata: { fields: Object.keys(input) },
      });
      return ok(res, member);
    } catch (error) {
      return fail(res, error);
    }
  });

  router.post("/model-pools/qianwen-free/install", canInstallPreset, (req, res) => {
    try {
      const result = installQianwenFreePool();
      auditRequest(req, { action: "pool.install_preset", targetType: "model_pool", metadata: { preset: "qianwen_free" } });
      return ok(res, result);
    } catch (error) {
      const missingProvider = error instanceof Error
        && error.message === "请先配置并启用千问服务商凭证";
      return fail(res, error, missingProvider ? 409 : errorStatus(error));
    }
  });

  router.post("/model-pools/qianwen-free/verify", canVerify, async (req, res) => {
    try {
      const input = verificationSchema.parse(req.body);
      const result = await verifyPoolMembers(input.ids, { enablePassed: input.enablePassed });
      auditRequest(req, { action: "pool.verify", targetType: "model_pool_member", metadata: { count: input.ids.length, enablePassed: input.enablePassed } });
      return ok(res, result);
    } catch (error) {
      return fail(res, error);
    }
  });

  router.post("/model-pool-members/verify", canVerify, async (req, res) => {
    try {
      const input = verificationSchema.parse(req.body);
      const result = await verifyPoolMembers(input.ids, { enablePassed: input.enablePassed });
      auditRequest(req, { action: "pool.verify", targetType: "model_pool_member", metadata: { count: input.ids.length, enablePassed: input.enablePassed } });
      return ok(res, result);
    } catch (error) {
      return fail(res, error);
    }
  });

  router.post("/model-pool-members/remove", canRemove, (req, res) => {
    try {
      const input = removalSchema.parse(req.body);
      const result = removePoolMembers(input.ids, { reason: input.reason, note: input.note });
      auditRequest(req, { action: "pool.remove", targetType: "model_pool_member", metadata: { count: input.ids.length, reason: input.reason } });
      return ok(res, result);
    } catch (error) {
      return fail(res, error);
    }
  });

  router.post("/model-pool-members/restore", canRestore, (req, res) => {
    try {
      const input = memberIdsSchema.parse(req.body);
      const result = restorePoolMembers(input.ids);
      auditRequest(req, { action: "pool.restore", targetType: "model_pool_member", metadata: { count: input.ids.length } });
      return ok(res, result);
    } catch (error) {
      return fail(res, error);
    }
  });

  router.get("/model-pool-settings", canReadPool, (_req, res) => {
    try {
      return ok(res, getModelPoolSettings());
    } catch (error) {
      return fail(res, error);
    }
  });

  router.patch("/model-pool-settings", canUpdateSettings, (req, res) => {
    try {
      const input = settingsPatchSchema.parse(req.body);
      const settings = updateModelPoolSettings(input);
      auditRequest(req, { action: "pool.update_settings", targetType: "model_pool", metadata: { fields: Object.keys(input) } });
      return ok(res, settings);
    } catch (error) {
      return fail(res, error);
    }
  });

  router.get("/model-usage-events", canReadPool, (req, res) => {
    try {
      return ok(res, listModelUsageEvents(usageFilterSchema.parse(req.query)));
    } catch (error) {
      return fail(res, error);
    }
  });

  return router;
}
