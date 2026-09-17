import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const dataRoot = path.join(os.tmpdir(), "customer-chat-analysis-smoke", `${process.pid}-${randomUUID()}`);
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 30000);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => port ? resolve(port) : reject(new Error("无法分配本地端口")));
    });
  });
}

async function waitFor(check, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await delay(300);
    }
  }
  throw new Error(`${label} 超时：${lastError instanceof Error ? lastError.message : "未就绪"}`);
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
let child;
let stderr = "";
let failed = false;

try {
  child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: path.join(dataRoot, "data"),
      DATABASE_PATH: path.join(dataRoot, "data", "app.db"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", () => undefined);
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });

  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`服务已退出（code ${child.exitCode}）：${stderr.trim()}`);
    }
    const response = await fetch(`${baseUrl}/api/health`);
    if (!response.ok) throw new Error(`健康检查返回 ${response.status}`);
    return response;
  }, "服务启动");

  const health = await (await fetch(`${baseUrl}/api/health`)).json();
  assert(health?.data?.status === "ok", "健康检查状态不是 ok");

  const page = await fetch(`${baseUrl}/`);
  assert(page.status === 200, `静态页面返回 ${page.status}`);
  assert((await page.text()).includes('id="root"'), "静态页面缺少挂载点");

  const ready = await fetch(`${baseUrl}/api/ready`);
  const readyBody = await ready.json();
  assert(
    (ready.status === 200) === (readyBody?.data?.ready === true),
    `就绪状态与响应码不一致：${ready.status}`,
  );
  assert(
    typeof readyBody?.data?.models?.vision === "boolean"
    && typeof readyBody?.data?.models?.text === "boolean",
    "就绪响应缺少模型状态",
  );

  const sync = await fetch(`${baseUrl}/api/knowledge-sync`);
  const syncBody = await sync.json();
  assert(
    sync.status === 200 && ["synced", "pending"].includes(syncBody?.data?.state),
    `知识快照状态异常：${sync.status}`,
  );

  console.log(JSON.stringify({
    smoke: "ok",
    health: health.data.status,
    ready: readyBody.data.ready,
    models: readyBody.data.models,
    knowledgeSync: syncBody.data.state,
  }));
} catch (error) {
  failed = true;
  console.error(`冒烟失败：${error instanceof Error ? error.message : error}`);
  if (stderr.trim()) console.error(stderr.trim());
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    const exited = await Promise.race([
      new Promise((resolve) => child.once("exit", () => resolve(true))),
      delay(5000).then(() => false),
    ]);
    if (!exited) {
      try {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).unref();
      } catch {
        /* 清理尽力而为 */
      }
    }
  }
  child?.stdout?.destroy();
  child?.stderr?.destroy();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;
