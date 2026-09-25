import crypto from "node:crypto";

const RANDOM_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const MAX_CONVERSATION_ID_ATTEMPTS = 20;

export interface ConversationIdDependencies {
  now?: () => Date;
  randomCode?: () => string;
  maxAttempts?: number;
}

export function formatShanghaiDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}`;
}

function generateRandomCode(): string {
  return Array.from(
    { length: 6 },
    () => RANDOM_ALPHABET[crypto.randomInt(RANDOM_ALPHABET.length)],
  ).join("");
}

function isUniqueConstraintError(error: unknown): boolean {
  return String(error).includes("UNIQUE constraint failed");
}

export function ensureConversationId(
  database: any,
  recordId: string,
  dependencies: ConversationIdDependencies = {},
): string {
  const record = database.prepare(`
    SELECT records.conversation_id, jobs.platform_code
    FROM records
    JOIN jobs ON jobs.id = records.job_id
    WHERE records.id = ?
  `).get(recordId) as {
    conversation_id: string | null;
    platform_code: string | null;
  } | undefined;

  if (!record) throw new Error("记录不存在");
  if (record.conversation_id) return record.conversation_id;
  if (!record.platform_code) throw new Error("历史任务缺少平台，请先补录平台后重试");

  const assignedAt = (dependencies.now ?? (() => new Date()))();
  const datePart = formatShanghaiDate(assignedAt);
  const randomCode = dependencies.randomCode ?? generateRandomCode;
  const maxAttempts = Math.max(
    1,
    Math.floor(dependencies.maxAttempts ?? MAX_CONVERSATION_ID_ATTEMPTS),
  );

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = randomCode();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      throw new Error("会话 ID 随机码必须为六位大写英文字母或数字");
    }
    const candidate = `${record.platform_code}${datePart}${code}`;

    try {
      database.prepare(`
        UPDATE records
        SET conversation_id = ?, conversation_id_assigned_at = ?
        WHERE id = ? AND conversation_id IS NULL
      `).run(candidate, assignedAt.toISOString(), recordId);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const current = database.prepare(
        "SELECT conversation_id FROM records WHERE id = ?",
      ).get(recordId) as { conversation_id: string | null } | undefined;
      if (current?.conversation_id) return current.conversation_id;
      continue;
    }

    const current = database.prepare(
      "SELECT conversation_id FROM records WHERE id = ?",
    ).get(recordId) as { conversation_id: string | null } | undefined;
    if (current?.conversation_id) return current.conversation_id;
  }

  throw new Error("会话 ID 生成失败：随机码碰撞次数超过上限");
}
