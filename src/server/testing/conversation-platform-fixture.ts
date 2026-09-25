import crypto from "node:crypto";
import { db } from "../db/client";

export function attachConversationTestPlatform(jobId: string) {
  const token = crypto.randomUUID().replaceAll("-", "").toUpperCase();
  const platform = {
    id: `test-platform-${token}`,
    code: `TEST${token.slice(0, 20)}`,
    name: `测试平台 ${token.slice(0, 8)}`,
  };
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO platforms (id, name, code, is_enabled, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run(platform.id, platform.name, platform.code, timestamp, timestamp);
  db.prepare(`
    UPDATE jobs
    SET platform_id = ?, platform_code = ?, platform_name = ?, updated_at = ?
    WHERE id = ? AND platform_id IS NULL
  `).run(platform.id, platform.code, platform.name, timestamp, jobId);
  return platform;
}
