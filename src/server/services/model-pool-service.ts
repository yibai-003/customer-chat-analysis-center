import crypto from "node:crypto";
import type {
  ModelPurpose,
  ModelRouteAttempt,
  ModelRouteResult,
} from "../../shared/types";
import {
  checkModelBudget,
  currentPaidTokenBudget,
  paidTokensRemaining,
  withModelBudget,
} from "../ai/model-budget";
import {
  callVisionModel,
  classifyModelError,
  type ClassifiedModelError,
} from "../ai/openai-compatible-client";
import { db } from "../db/client";
import {
  redactCredential,
  resolvePoolMembers,
  type ResolvedPoolMember,
} from "./model-provider-service";

export interface ModelPoolCallOptions {
  purpose: ModelPurpose;
  recordId?: string;
  fieldId?: string;
  operation: string;
  signal?: AbortSignal;
  validate?: (content: string) => { valid: boolean; repairedContent?: string };
}

type RouteErrorCode = ClassifiedModelError["code"] | "invalid_output";
type Usage = { prompt_tokens?: number; completion_tokens?: number };

export class ModelPoolError extends Error {
  constructor(
    public readonly code: RouteErrorCode,
    message: string,
    public readonly attempts: ModelRouteAttempt[] = [],
  ) {
    super(message);
  }
}

function expiryTime(member: ResolvedPoolMember) {
  if (!member.quotaExpiresAt) return Number.POSITIVE_INFINITY;
  const value = Date.parse(member.quotaExpiresAt);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function remainingQuota(member: ResolvedPoolMember) {
  return Math.max(0, (member.quotaTotalTokens ?? Number.MAX_SAFE_INTEGER) - member.quotaUsedTokens);
}

function commonEligible(
  member: ResolvedPoolMember,
  now: number,
  failedMemberIds: ReadonlySet<string>,
) {
  if (!member.isEnabled
    || !member.poolEnabled
    || !member.providerEnabled
    || !member.capabilityEligible
    || member.memberType !== "general"
    || failedMemberIds.has(member.id)) return false;
  if (member.cooldownUntil && Date.parse(member.cooldownUntil) > now) return false;
  if (member.billingMode === "free") {
    if (expiryTime(member) <= now) return false;
    const safetyLimit = (member.quotaTotalTokens ?? 0) * member.quotaSafetyRatio;
    if (member.quotaBlocked || member.quotaUsedTokens >= safetyLimit) return false;
  }
  return true;
}

export function rankPoolCandidates(
  members: ResolvedPoolMember[],
  options: {
    now: number;
    allowPaid: boolean;
    failedMemberIds: ReadonlySet<string>;
  },
): ResolvedPoolMember[] {
  const eligible = members.filter((member) =>
    commonEligible(member, options.now, options.failedMemberIds)
      && (member.billingMode === "free" || options.allowPaid)
  );
  const hasNonThinkingFree = eligible.some((member) =>
    member.billingMode === "free" && !member.thinkingMode
  );
  const tier = { A: 0, B: 1, C: 2 } as const;
  return eligible
    .filter((member) =>
      !(hasNonThinkingFree && member.billingMode === "free" && member.thinkingMode)
    )
    .sort((left, right) => {
      if (left.billingMode !== right.billingMode) return left.billingMode === "free" ? -1 : 1;
      if (left.billingMode === "free") {
        const expiryDifference = expiryTime(left) - expiryTime(right);
        if (expiryDifference) return expiryDifference;
        const quotaDifference = remainingQuota(left) - remainingQuota(right);
        if (quotaDifference) return quotaDifference;
      }
      if (tier[left.qualityTier] !== tier[right.qualityTier]) {
        return tier[left.qualityTier] - tier[right.qualityTier];
      }
      if (left.thinkingMode !== right.thinkingMode) return left.thinkingMode ? 1 : -1;
      if (left.priority !== right.priority) return left.priority - right.priority;
      return left.consecutiveFailures - right.consecutiveFailures || left.id.localeCompare(right.id);
    });
}

function usageDetails(usage: Usage) {
  const input = Number.isSafeInteger(usage.prompt_tokens) && Number(usage.prompt_tokens) >= 0
    ? Number(usage.prompt_tokens)
    : undefined;
  const output = Number.isSafeInteger(usage.completion_tokens) && Number(usage.completion_tokens) >= 0
    ? Number(usage.completion_tokens)
    : undefined;
  return {
    input,
    output,
    known: input !== undefined || output !== undefined,
    total: (input ?? 0) + (output ?? 0),
  };
}

function insertEvent(
  member: ResolvedPoolMember,
  options: ModelPoolCallOptions,
  event: {
    type: "success" | "failure" | "switch" | "quota_exhausted"
      | "cooldown" | "paid_blocked" | "usage_unknown";
    usage?: Usage;
    accountedTokens?: number;
    errorCode?: RouteErrorCode;
    errorMessage?: string;
    durationMs?: number;
  },
) {
  const usage = usageDetails(event.usage ?? {});
  db.prepare(`INSERT INTO model_usage_events (
    id,model_config_id,provider_id,purpose,event_type,input_tokens,output_tokens,
    accounted_tokens,error_code,error_message,record_id,field_id,operation,duration_ms,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    crypto.randomUUID(),
    member.id,
    member.providerId ?? null,
    options.purpose,
    event.type,
    usage.input ?? null,
    usage.output ?? null,
    event.accountedTokens ?? 0,
    event.errorCode ?? null,
    event.errorMessage ?? null,
    options.recordId ?? null,
    options.fieldId ?? null,
    options.operation,
    event.durationMs ?? null,
    new Date().toISOString(),
  );
}

function paidUsageSince(start: string) {
  return (db.prepare(`SELECT COALESCE(SUM(e.accounted_tokens),0) total
    FROM model_usage_events e
    JOIN model_configs m ON m.id=e.model_config_id
    WHERE m.billing_mode='paid' AND e.created_at>=?`).get(start) as { total: number }).total;
}

let paidReservationColumnsReady = false;

function ensurePaidReservationColumns() {
  if (paidReservationColumnsReady) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info(model_pool_settings)").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  for (const [name, definition] of [
    ["paid_reservation_day", "TEXT"],
    ["paid_reservation_month", "TEXT"],
    ["paid_daily_reserved_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["paid_monthly_reserved_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ] as const) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE model_pool_settings ADD COLUMN ${name} ${definition}`);
    }
  }
  paidReservationColumnsReady = true;
}

interface PaidReservation {
  day: string;
  month: string;
  tokens: number;
}

function reservePersistedPaidAllowance(member: ResolvedPoolMember): PaidReservation {
  ensurePaidReservationColumns();
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const month = now.slice(0, 7);
  const dayStart = `${day}T00:00:00.000Z`;
  const monthStart = `${month}-01T00:00:00.000Z`;

  return db.transaction(() => {
    const settings = db.prepare(`SELECT paid_daily_token_limit daily, paid_monthly_token_limit monthly,
      paid_reservation_day reservationDay, paid_reservation_month reservationMonth,
      paid_daily_reserved_tokens dailyReserved, paid_monthly_reserved_tokens monthlyReserved
      FROM model_pool_settings WHERE id='default'`).get() as {
        daily: number;
        monthly: number;
        reservationDay: string | null;
        reservationMonth: string | null;
        dailyReserved: number;
        monthlyReserved: number;
      } | undefined;
    if (!settings) throw new Error("模型池设置不存在");
    const dailyReserved = settings.reservationDay === day ? settings.dailyReserved : 0;
    const monthlyReserved = settings.reservationMonth === month ? settings.monthlyReserved : 0;
    const dailyUsed = paidUsageSince(dayStart);
    const monthlyUsed = paidUsageSince(monthStart);
    if (settings.daily <= 0
      || settings.monthly <= 0
      || dailyUsed + dailyReserved + member.maxTokens > settings.daily
      || monthlyUsed + monthlyReserved + member.maxTokens > settings.monthly) {
      throw new ModelPoolError("budget", "付费模型已达到日或月 Token 预算");
    }
    db.prepare(`UPDATE model_pool_settings SET paid_reservation_day=?,
      paid_reservation_month=?, paid_daily_reserved_tokens=?,
      paid_monthly_reserved_tokens=?, updated_at=? WHERE id='default'`)
      .run(day, month, dailyReserved + member.maxTokens, monthlyReserved + member.maxTokens, now);
    return { day, month, tokens: member.maxTokens };
  })();
}

function releasePersistedPaidAllowance(reservation: PaidReservation) {
  db.prepare(`UPDATE model_pool_settings SET
    paid_daily_reserved_tokens=MAX(0, paid_daily_reserved_tokens-?),
    paid_monthly_reserved_tokens=MAX(0, paid_monthly_reserved_tokens-?),
    updated_at=? WHERE id='default' AND paid_reservation_day=?
      AND paid_reservation_month=?`).run(
    reservation.tokens,
    reservation.tokens,
    new Date().toISOString(),
    reservation.day,
    reservation.month,
  );
}

type FailurePolicy = "none" | "quota" | "cooldown" | "provider" | "member";

function recordFailurePolicy(
  member: ResolvedPoolMember,
  options: ModelPoolCallOptions,
  code: RouteErrorCode,
  message: string,
  durationMs: number,
  policy: FailurePolicy,
) {
  const now = new Date();
  const timestamp = now.toISOString();
  const cooldownUntil = new Date(
    now.getTime() + Math.min(1800, 60 * 2 ** Math.max(0, member.consecutiveFailures)) * 1000,
  ).toISOString();
  db.transaction(() => {
    if (policy === "quota") {
      db.prepare(`UPDATE model_configs SET quota_exhausted_at=?,last_failure_at=?,updated_at=?
        WHERE id=?`).run(timestamp, timestamp, timestamp, member.id);
    } else if (policy === "cooldown") {
      db.prepare(`UPDATE model_configs SET consecutive_failures=consecutive_failures+1,
        cooldown_until=?,last_failure_at=?,updated_at=? WHERE id=?`)
        .run(cooldownUntil, timestamp, timestamp, member.id);
    } else if (policy === "member") {
      db.prepare(`UPDATE model_configs SET is_enabled=0,last_failure_at=?,updated_at=?
        WHERE id=?`).run(timestamp, timestamp, member.id);
    } else if (policy === "provider" && member.providerId) {
      db.prepare(`UPDATE model_providers SET is_enabled=0,last_error=?,updated_at=?
        WHERE id=?`).run(redactCredential(message, member.apiKey).slice(0, 1000), timestamp, member.providerId);
      db.prepare("UPDATE model_configs SET last_failure_at=?,updated_at=? WHERE id=?")
        .run(timestamp, timestamp, member.id);
    } else {
      db.prepare("UPDATE model_configs SET last_failure_at=?,updated_at=? WHERE id=?")
        .run(timestamp, timestamp, member.id);
    }
    insertEvent(member, options, {
      type: "failure",
      errorCode: code,
      errorMessage: message,
      durationMs,
    });
    if (policy === "quota") {
      insertEvent(member, options, {
        type: "quota_exhausted",
        errorCode: code,
        errorMessage: message,
        durationMs,
      });
    } else if (policy === "cooldown") {
      insertEvent(member, options, { type: "cooldown", durationMs });
    }
  })();
}

function sanitizeError(member: ResolvedPoolMember, error: ClassifiedModelError) {
  return {
    ...error,
    message: redactCredential(error.message, member.apiKey).slice(0, 1000),
  };
}

function markSuccess(
  member: ResolvedPoolMember,
  options: ModelPoolCallOptions,
  usage: Usage,
  accountedTokens: number,
  durationMs: number,
  unknownPaidUsage: boolean,
  paidReservation?: PaidReservation,
) {
  const details = usageDetails(usage);
  const now = new Date().toISOString();
  db.transaction(() => {
    if (paidReservation) releasePersistedPaidAllowance(paidReservation);
    if (member.billingMode === "free" && details.known) {
      db.prepare(`UPDATE model_configs SET quota_used_tokens=quota_used_tokens+?,
        consecutive_failures=0,cooldown_until=NULL,last_success_at=?,updated_at=? WHERE id=?`)
        .run(details.total, now, now, member.id);
    } else {
      db.prepare(`UPDATE model_configs SET consecutive_failures=0,cooldown_until=NULL,
        last_success_at=?,updated_at=? WHERE id=?`).run(now, now, member.id);
    }
    insertEvent(member, options, {
      type: "success",
      usage,
      accountedTokens: unknownPaidUsage ? 0 : accountedTokens,
      durationMs,
    });
    if (unknownPaidUsage) {
      insertEvent(member, options, {
        type: "usage_unknown",
        accountedTokens,
        durationMs,
      });
    }
  })();
}

function markFailure(
  member: ResolvedPoolMember,
  options: ModelPoolCallOptions,
  code: RouteErrorCode,
  message: string,
  durationMs: number,
  usage: Usage = {},
  accountedTokens = 0,
  unknownPaidUsage = false,
) {
  db.transaction(() => {
    db.prepare("UPDATE model_configs SET last_failure_at=?,updated_at=? WHERE id=?")
      .run(new Date().toISOString(), new Date().toISOString(), member.id);
    insertEvent(member, options, {
      type: "failure",
      usage,
      accountedTokens: unknownPaidUsage ? 0 : accountedTokens,
      errorCode: code,
      errorMessage: message,
      durationMs,
    });
    if (unknownPaidUsage) {
      insertEvent(member, options, {
        type: "usage_unknown",
        accountedTokens,
        errorCode: code,
        durationMs,
      });
    }
  })();
}

function assertRunnable(options: ModelPoolCallOptions, attempts: ModelRouteAttempt[]) {
  try {
    options.signal?.throwIfAborted();
    checkModelBudget();
  } catch (error) {
    const classified = classifyModelError(error);
    throw new ModelPoolError(classified.code, classified.message, attempts);
  }
}

async function transportCall(member: ResolvedPoolMember, messages: unknown[], options: ModelPoolCallOptions) {
  let reserved = 0;
  let paidReservation: PaidReservation | undefined;
  const paidBudget = currentPaidTokenBudget();
  if (member.billingMode === "paid") {
    if (!paidBudget) throw new ModelPoolError("budget", "当前批次未启用付费 Token 预算");
    try {
      paidBudget.reservePaidTokens(member.maxTokens);
    } catch (error) {
      const classified = classifyModelError(error);
      throw new ModelPoolError("budget", classified.message);
    }
    reserved = member.maxTokens;
    try {
      paidReservation = reservePersistedPaidAllowance(member);
    } catch (error) {
      paidBudget.settlePaidTokens(reserved, 0);
      throw error;
    }
  }
  try {
    const response = await callVisionModel(member, messages, { attempts: 1, signal: options.signal });
    const usage = usageDetails(response.usage);
    if (member.billingMode === "paid" && usage.known) {
      paidBudget!.settlePaidTokens(reserved, usage.total);
    }
    return {
      ...response,
      usage: response.usage as Usage,
      accountedTokens: member.billingMode === "paid" && !usage.known ? reserved : usage.total,
      unknownPaidUsage: member.billingMode === "paid" && !usage.known,
      paidReservation,
    };
  } catch (error) {
    if (reserved) paidBudget!.settlePaidTokens(reserved, 0);
    if (paidReservation) releasePersistedPaidAllowance(paidReservation);
    throw error;
  }
}

function validateContent(
  content: string,
  validate: ModelPoolCallOptions["validate"],
) {
  if (!validate) return { valid: true, content };
  const result = validate(content);
  if (result.valid) return { valid: true, content };
  if (result.repairedContent !== undefined && validate(result.repairedContent).valid) {
    return { valid: true, content: result.repairedContent };
  }
  return { valid: false, content };
}

function hasPaidCandidate(
  members: ResolvedPoolMember[],
  now: number,
  failedMemberIds: ReadonlySet<string>,
) {
  return rankPoolCandidates(members, {
    now,
    allowPaid: true,
    failedMemberIds,
  }).find((member) => member.billingMode === "paid");
}

async function routeModelPool(
  messages: unknown[],
  options: ModelPoolCallOptions,
): Promise<ModelRouteResult> {
  const allMembers = resolvePoolMembers(options.purpose);
  const failedMemberIds = new Set<string>();
  const attempts: ModelRouteAttempt[] = [];
  let lastError: ModelPoolError | undefined;

  while (true) {
    assertRunnable(options, attempts);
    const now = Date.now();
    const candidates = rankPoolCandidates(allMembers, {
      now,
      allowPaid: paidTokensRemaining() > 0,
      failedMemberIds,
    });
    const candidate = candidates[0];
    if (!candidate) {
      const blockedPaid = hasPaidCandidate(allMembers, now, failedMemberIds);
      if (blockedPaid) {
        insertEvent(blockedPaid, options, {
          type: "paid_blocked",
          errorCode: "budget",
          errorMessage: "当前批次付费 Token 预算为零",
        });
        throw new ModelPoolError("budget", "当前批次付费 Token 预算为零", attempts);
      }
      if (lastError) throw lastError;
      throw new ModelPoolError("configuration", "没有符合条件的模型池成员", attempts);
    }

    let retry = 0;
    while (retry < 2) {
      assertRunnable(options, attempts);
      const started = Date.now();
      try {
        const response = await transportCall(candidate, messages, options);
        const durationMs = Date.now() - started;
        const validated = validateContent(response.content, options.validate);
        if (validated.valid) {
          markSuccess(
            candidate,
            options,
            response.usage,
            response.accountedTokens,
            durationMs,
            response.unknownPaidUsage,
            response.paidReservation,
          );
          attempts.push({
            modelConfigId: candidate.id,
            model: candidate.model,
            status: "success",
            durationMs,
          });
          return {
            content: validated.content,
            raw: response.raw,
            usage: response.usage,
            model: candidate,
            attempts,
          };
        }

        markFailure(
          candidate,
          options,
          "invalid_output",
          "模型输出未通过本地校验",
          durationMs,
          response.usage,
          response.accountedTokens,
          response.unknownPaidUsage,
        );
        attempts.push({
          modelConfigId: candidate.id,
          model: candidate.model,
          status: "failed",
          errorCode: "invalid_output",
          durationMs,
        });
        if (retry === 0) {
          retry += 1;
          continue;
        }
        recordFailurePolicy(
          candidate,
          options,
          "invalid_output",
          "模型输出未通过本地校验",
          durationMs,
          "cooldown",
        );
        lastError = new ModelPoolError("invalid_output", "模型输出未通过本地校验", attempts);
        break;
      } catch (error) {
        if (error instanceof ModelPoolError) {
          if (error.code === "budget") {
            insertEvent(candidate, options, {
              type: "paid_blocked",
              errorCode: "budget",
              errorMessage: error.message,
            });
          }
          throw new ModelPoolError(error.code, error.message, attempts);
        }
        const classified = sanitizeError(candidate, classifyModelError(error));
        const durationMs = Date.now() - started;
        attempts.push({
          modelConfigId: candidate.id,
          model: candidate.model,
          status: "failed",
          errorCode: classified.code,
          durationMs,
        });

        if (classified.code === "cancelled" || classified.code === "budget") {
          markFailure(candidate, options, classified.code, classified.message, durationMs);
          throw new ModelPoolError(classified.code, classified.message, attempts);
        }
        if (classified.code === "quota_exhausted") {
          recordFailurePolicy(candidate, options, classified.code, classified.message, durationMs, "quota");
          lastError = new ModelPoolError(classified.code, classified.message, attempts);
          break;
        }
        if (classified.code === "rate_limit") {
          recordFailurePolicy(candidate, options, classified.code, classified.message, durationMs, "cooldown");
          lastError = new ModelPoolError(classified.code, classified.message, attempts);
          break;
        }
        if (classified.code === "auth") {
          if (candidate.providerId) {
            recordFailurePolicy(candidate, options, classified.code, classified.message, durationMs, "provider");
            for (const member of allMembers) {
              if (member.providerId === candidate.providerId) failedMemberIds.add(member.id);
            }
          } else {
            recordFailurePolicy(candidate, options, classified.code, classified.message, durationMs, "member");
          }
          lastError = new ModelPoolError(classified.code, classified.message, attempts);
          break;
        }
        if (classified.code === "model"
          && (classified.httpStatus === 400
            || classified.httpStatus === 404
            || /model.+(?:not found|does not exist)/i.test(classified.message))) {
          recordFailurePolicy(candidate, options, classified.code, classified.message, durationMs, "member");
          lastError = new ModelPoolError(classified.code, classified.message, attempts);
          break;
        }
        if (classified.code === "service"
          || classified.code === "timeout"
          || classified.code === "network") {
          if (retry === 0) {
            markFailure(candidate, options, classified.code, classified.message, durationMs);
            retry += 1;
            continue;
          }
          recordFailurePolicy(candidate, options, classified.code, classified.message, durationMs, "cooldown");
          lastError = new ModelPoolError(classified.code, classified.message, attempts);
          break;
        }

        markFailure(candidate, options, classified.code, classified.message, durationMs);
        throw new ModelPoolError(classified.code, classified.message, attempts);
      }
    }

    failedMemberIds.add(candidate.id);
    const next = rankPoolCandidates(allMembers, {
      now: Date.now(),
      allowPaid: paidTokensRemaining() > 0,
      failedMemberIds,
    })[0];
    if (next) {
      insertEvent(candidate, options, {
        type: "switch",
        errorCode: lastError?.code,
        errorMessage: lastError?.message,
      });
      const latest = attempts.at(-1);
      if (latest) latest.status = "switched";
    }
  }
}

export async function callModelPool(
  messages: unknown[],
  options: ModelPoolCallOptions,
): Promise<ModelRouteResult> {
  return withModelBudget(
    () => routeModelPool(messages, options),
    { signal: options.signal },
  );
}
