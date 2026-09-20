import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const testRoot = path.join(os.tmpdir(), "customer-chat-analysis-vitest", `${process.pid}-${randomUUID()}`);
process.env.DATA_DIR = path.join(testRoot, "data");
process.env.DATABASE_PATH = path.join(testRoot, "data", "app.db");
process.env.FIRST_ADMIN_USERNAME = "admin";
process.env.FIRST_ADMIN_PASSWORD = "test-password-123";
process.env.FIRST_ADMIN_DISPLAY_NAME = "测试管理员";

if (typeof HTMLCanvasElement !== "undefined") {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: () => null,
  });
}
