import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const testRoot = path.join(os.tmpdir(), "customer-chat-analysis-vitest", `${process.pid}-${randomUUID()}`);
process.env.DATA_DIR = path.join(testRoot, "data");
process.env.DATABASE_PATH = path.join(testRoot, "data", "app.db");
