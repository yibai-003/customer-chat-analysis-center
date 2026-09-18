// 模型池基线收敛：默认输出脱敏清单，`--apply` 先备份再隔离测试模型/供应商并设置正式默认模型。
// 全部通过公开 API 完成（不直接改数据库），变更自动进入审计。
// 环境变量：BASELINE_BASE_URL、BASELINE_ADMIN_USERNAME/PASSWORD、BASELINE_TLS_VERIFY、
// BASELINE_CONNECT_HOST（仅演练）、BASELINE_ORIGIN；API Key 不经过本脚本。
import http from "node:http";
import https from "node:https";

const url = new URL(process.env.BASELINE_BASE_URL ?? "https://chat.example.lan");
const HOST = url.hostname;
const PORT = url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
const CONNECT = process.env.BASELINE_CONNECT_HOST ?? HOST;
const ORIGIN = process.env.BASELINE_ORIGIN ?? url.origin;
const USER = process.env.BASELINE_ADMIN_USERNAME ?? "admin";
const PASS = process.env.BASELINE_ADMIN_PASSWORD ?? "";
const VERIFY = process.env.BASELINE_TLS_VERIFY !== "false";
const APPLY = process.argv.includes("--apply");
const TEST_NAME = /测试|验收|桩|stub|test|acceptance/i;
const TEST_HOST = /^(localhost|host\.docker\.internal|127\.0\.0\.1)$/i;

function request(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = (url.protocol === "http:" ? http : https).request({
      host: CONNECT, port: PORT, method, path, servername: HOST,
      rejectUnauthorized: VERIFY,
      headers: {
        Host: HOST, Origin: ORIGIN, "sec-fetch-site": "same-origin",
        ...(cookie ? { cookie } : {}),
        ...(payload ? { "content-type": "application/json" } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { parsed = {}; }
        resolve({ status: res.statusCode, body: parsed, cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (path, cookie) => request("GET", path, undefined, cookie);
const post = (path, body, cookie) => request("POST", path, body, cookie);
const patch = (path, body, cookie) => request("PATCH", path, body, cookie);
function expect(result, label) {
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${label} 失败：${result.status} ${JSON.stringify(result.body).slice(0, 200)}`);
  }
  return result.body.data;
}

async function survey(cookie) {
  const [providers, models, settings, usage, ready] = await Promise.all([
    get("/api/model-providers", cookie),
    get("/api/model-configs", cookie),
    get("/api/model-pool-settings", cookie),
    get("/api/model-usage-events?limit=200", cookie),
    get("/api/ready", cookie),
  ]);
  const providerList = expect(providers, "供应商列表").map((item) => ({
    id: item.id, name: item.name, host: new URL(item.baseUrl).hostname, maskedApiKey: item.maskedApiKey,
    isEnabled: item.isEnabled, lastTestedAt: item.lastTestedAt ?? null, lastError: item.lastError ?? null,
    test: TEST_HOST.test(new URL(item.baseUrl).hostname) || TEST_NAME.test(item.name),
  }));
  const providerById = new Map(providerList.map((item) => [item.id, item]));
  const usageByModel = new Map();
  for (const event of expect(usage, "用量事件")) {
    usageByModel.set(event.modelConfigId, (usageByModel.get(event.modelConfigId) ?? 0) + 1);
  }
  const modelList = expect(models, "模型列表").map((item) => {
    const provider = item.providerId ? providerById.get(item.providerId) : undefined;
    return {
      id: item.id, name: item.name, purpose: item.purpose, model: item.model,
      providerName: item.providerName ?? null, isEnabled: item.isEnabled, poolEnabled: item.poolEnabled,
      isPurposeDefault: item.isPurposeDefault, verified: Boolean(item.capabilityEligible),
      capability: item.capabilityStatus ?? null, checkedAt: item.capabilityCheckedAt ?? null,
      usageEvents: usageByModel.get(item.id) ?? 0,
      test: TEST_NAME.test(item.name) || Boolean(provider?.test),
    };
  });
  const readinessData = ready.body.data ?? {};
  const readiness = {
    reachable: ready.status === 200 || ready.status === 503,
    ready: Boolean(readinessData.ready),
    vision: readinessData.modelChecks?.vision?.state ?? "unknown",
    text: readinessData.modelChecks?.text?.state ?? "unknown",
    freeDiskMb: readinessData.freeDiskMb ?? null,
    error: ready.status === 503 ? ready.body.error ?? null : null,
  };
  return {
    entry: `${url.protocol}//${HOST}${url.port ? `:${url.port}` : ""}`,
    settings: expect(settings, "池设置"),
    providers: providerList,
    models: modelList,
    readiness,
  };
}

function formalDefault(models, purpose) {
  return models.find((item) => item.purpose === purpose && !item.test && item.isEnabled && item.poolEnabled && item.verified)
    ?? null;
}

const login = await post("/api/auth/login", { username: USER, password: PASS });
if (login.status !== 200 || !login.cookie) throw new Error(`管理员登录失败：${login.status}`);
const cookie = login.cookie;

let report = await survey(cookie);
console.log(JSON.stringify({ mode: APPLY ? "apply" : "report", ...report }, null, 2));

if (APPLY) {
  const backup = expect(await post("/api/admin/backups", {}, cookie), "变更前备份");
  const actions = [];
  for (const model of report.models.filter((item) => item.test)) {
    if (model.poolEnabled) { expect(await patch(`/api/model-pool-members/${model.id}`, { poolEnabled: false }, cookie), `移出池 ${model.name}`); actions.push(`移出路由池：${model.name}`); }
    if (model.isEnabled) { expect(await patch(`/api/model-configs/${model.id}`, { isEnabled: false }, cookie), `停用 ${model.name}`); actions.push(`停用模型：${model.name}`); }
  }
  for (const provider of report.providers.filter((item) => item.test && item.isEnabled)) {
    expect(await patch(`/api/model-providers/${provider.id}`, { isEnabled: false }, cookie), `停用供应商 ${provider.name}`);
    actions.push(`停用供应商：${provider.name}`);
  }
  for (const purpose of ["vision", "text"]) {
    const target = formalDefault(report.models, purpose);
    if (target && !target.isPurposeDefault) {
      expect(await post(`/api/model-configs/${target.id}/default`, { purpose }, cookie), `默认 ${purpose}`);
      actions.push(`设默认 ${purpose}：${target.name}`);
    }
  }
  report = await survey(cookie);
  const blocked = ["vision", "text"].filter((purpose) => !formalDefault(report.models, purpose));
  console.log(JSON.stringify({
    backup: backup.name,
    actions,
    blockedPurposes: blocked,
    blockedNote: blocked.length ? `阻塞：${blocked.join("/")} 尚无已验证的正式模型，解析路由将不可用，禁止将测试模型标记为正式通过` : null,
    readiness: report.readiness,
  }, null, 2));
  if (blocked.length) process.exitCode = 1;
}
