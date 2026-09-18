// LAN release acceptance client. Runs on a workstation against the internal HTTPS
// entry (self-signed certificate accepted only for this drill) and exercises the
// five-role permission matrix, shared data, audit trail and administrator-only
// operations. Output is machine-readable JSON for the orchestrating PowerShell script.
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import crypto from "node:crypto";

const HOST = process.env.ACCEPTANCE_HOST ?? "chat.example.lan";
const PORT = Number(process.env.ACCEPTANCE_PORT ?? 8443);
const ORIGIN = `https://${HOST}`;
const SAMPLE = process.env.ACCEPTANCE_SAMPLE ?? "sample-chat.xlsx";
const ADMIN = {
  username: process.env.ACCEPTANCE_ADMIN_USERNAME ?? "admin",
  password: process.env.ACCEPTANCE_ADMIN_PASSWORD ?? "acceptance-admin-123",
};
const ACCOUNTS = [
  { role: "config", username: "acceptance-config", password: "acceptance-config-123", displayName: "验收配置" },
  { role: "operator", username: "acceptance-operator", password: "acceptance-operator-123", displayName: "验收操作" },
  { role: "reviewer", username: "acceptance-reviewer", password: "acceptance-reviewer-123", displayName: "验收审核" },
  { role: "readonly", username: "acceptance-readonly", password: "acceptance-readonly-123", displayName: "验收只读" },
];
const SECRETS = [ADMIN.password, ...ACCOUNTS.map((account) => account.password), "acceptance-secret-key-123", "password_hash", "cc_sid"];

const steps = [];
const state = { cookies: {}, jobId: "", recordId: "", backupName: "", auditEvents: [] };

function record(name, ok, detail) {
  steps.push({ name, ok, detail: detail ?? null });
  if (!ok) console.error(`FAIL ${name}: ${JSON.stringify(detail)}`);
}

async function step(name, run) {
  try {
    const detail = await run();
    record(name, true, detail ?? null);
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawRequest({ method = "GET", path: requestPath, cookie, headers = {}, body, contentType }) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: "127.0.0.1",
      port: PORT,
      method,
      path: requestPath,
      servername: HOST,
      rejectUnauthorized: false,
      headers: {
        Host: HOST,
        Origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        ...(cookie ? { cookie } : {}),
        ...(contentType ? { "content-type": contentType } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        buffer: Buffer.concat(chunks),
      }));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function jsonRequest(method, requestPath, options = {}) {
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  const response = await rawRequest({
    method,
    path: requestPath,
    cookie: options.cookie,
    headers: options.headers,
    body: payload,
    contentType: payload ? "application/json" : undefined,
  });
  let body = {};
  try { body = JSON.parse(response.buffer.toString("utf8")); } catch { body = {}; }
  return { status: response.status, body, headers: response.headers };
}

async function login(username, password) {
  const response = await jsonRequest("POST", "/api/auth/login", { body: { username, password } });
  const setCookie = response.headers["set-cookie"]?.[0];
  return { status: response.status, cookie: setCookie ? setCookie.split(";")[0] : undefined, body: response.body };
}

function requireStatus(result, expected, label) {
  if (result.status !== expected) {
    throw new Error(`${label} 期望 ${expected}，实际 ${result.status}：${JSON.stringify(result.body).slice(0, 200)}`);
  }
  return result;
}

function multipart(filePath, fields) {
  const boundary = `----lanAcceptance${crypto.randomBytes(8).toString("hex")}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(filePath)}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`));
  parts.push(fs.readFileSync(filePath));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function waitFor(test, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await test();
    if (last) return last;
    await sleep(500);
  }
  throw new Error(`${label} 超时`);
}

await step("https-health", async () => {
  const response = await jsonRequest("GET", "/api/health");
  requireStatus(response, 200, "health");
  if (response.body?.data?.status !== "ok") throw new Error("健康状态不是 ok");
  return { status: response.body.data.status };
});

await step("admin-login", async () => {
  const admin = await login(ADMIN.username, ADMIN.password);
  if (admin.status !== 200 || !admin.cookie) throw new Error(`管理员登录失败：${admin.status}`);
  state.cookies.admin = admin.cookie;
  return { capabilities: admin.body?.data?.capabilities?.length ?? 0 };
});

await step("create-role-accounts", async () => {
  for (const account of ACCOUNTS) {
    const created = await jsonRequest("POST", "/api/admin/users", {
      cookie: state.cookies.admin,
      body: { username: account.username, password: account.password, displayName: account.displayName, role: account.role },
    });
    requireStatus(created, 200, `创建 ${account.role}`);
    const session = await login(account.username, account.password);
    if (session.status !== 200 || !session.cookie) throw new Error(`${account.role} 登录失败：${session.status}`);
    state.cookies[account.role] = session.cookie;
  }
  const denied = await jsonRequest("GET", "/api/admin/users", { cookie: state.cookies.operator });
  requireStatus(denied, 403, "操作人员账号管理拒绝");
  return { accounts: ACCOUNTS.length + 1 };
});

await step("shared-reads", async () => {
  const details = {};
  for (const role of ["admin", "config", "operator", "reviewer", "readonly"]) {
    requireStatus(await jsonRequest("GET", "/api/jobs", { cookie: state.cookies[role] }), 200, `${role} 任务列表`);
    requireStatus(await jsonRequest("GET", "/api/sections", { cookie: state.cookies[role] }), 200, `${role} 板块`);
    requireStatus(await jsonRequest("GET", "/api/model-configs", { cookie: state.cookies[role] }), 200, `${role} 模型列表`);
    details[role] = "ok";
  }
  return details;
});

await step("anonymous-denied", async () => {
  requireStatus(await jsonRequest("GET", "/api/jobs"), 401, "匿名任务列表");
  requireStatus(await jsonRequest("GET", "/api/records/missing/image"), 401, "匿名图片");
  requireStatus(await jsonRequest("GET", "/api/admin/audit-events"), 401, "匿名审计");
  return { denied: ["/api/jobs", "/api/records/:id/image", "/api/admin/audit-events"] };
});

await step("import-as-operator", async () => {
  const upload = multipart(SAMPLE, { sectionId: "refund" });
  const imported = await rawRequest({
    method: "POST",
    path: "/api/jobs/import",
    cookie: state.cookies.operator,
    body: upload.body,
    contentType: upload.contentType,
  });
  let created = {};
  try { created = JSON.parse(imported.buffer.toString("utf8")); } catch { created = {}; }
  if (imported.status !== 200 || !created?.data?.id) {
    throw new Error(`导入失败：${imported.status} ${JSON.stringify(created).slice(0, 200)}`);
  }
  const importJobId = created.data.id;
  const finished = await waitFor(async () => {
    const status = await jsonRequest("GET", `/api/import-jobs/${importJobId}`, { cookie: state.cookies.operator });
    if (status.status !== 200) return undefined;
    return ["completed", "failed"].includes(status.body?.data?.status) ? status.body.data : undefined;
  }, 90_000, "导入任务");
  if (finished.status !== "completed") throw new Error(`导入状态 ${finished.status}：${finished.errorMessage ?? ""}`);
  for (const role of ["config", "reviewer", "readonly"]) {
    const denied = await jsonRequest("POST", "/api/jobs/import-preview", { cookie: state.cookies[role], body: {} });
    requireStatus(denied, 403, `${role} 导入拒绝`);
  }
  const jobs = await jsonRequest("GET", "/api/jobs", { cookie: state.cookies.operator });
  const job = jobs.body.data.find((item) => item.id === finished.jobId) ?? jobs.body.data[0];
  state.jobId = job.id;
  const records = await jsonRequest("GET", `/api/jobs/${job.id}/records?page=1&pageSize=1`, { cookie: state.cookies.operator });
  state.recordId = records.body.data.items[0].id;
  return { jobId: state.jobId, recordId: state.recordId, totalRecords: job.totalRecords };
});

await step("image-shared-view", async () => {
  for (const role of ["admin", "config", "operator", "reviewer", "readonly"]) {
    const image = await rawRequest({ path: `/api/records/${state.recordId}/image`, cookie: state.cookies[role] });
    if (image.status !== 200 || !String(image.headers["content-type"] ?? "").startsWith("image/")) {
      throw new Error(`${role} 图片访问失败：${image.status}`);
    }
  }
  return { path: `/api/records/${state.recordId}/image` };
});

await step("review-matrix", async () => {
  const reviewer = await jsonRequest("PATCH", `/api/records/${state.recordId}`, {
    cookie: state.cookies.reviewer,
    headers: { "x-request-id": "acceptance-review-1" },
    body: { sectionId: "refund", humanResult: { 验收: "复核通过" }, reviewStatus: "confirmed", reviewNote: "acceptance", status: "completed" },
  });
  requireStatus(reviewer, 200, "审核人员复核");
  for (const role of ["config", "operator", "readonly"]) {
    requireStatus(await jsonRequest("PATCH", `/api/records/${state.recordId}`, {
      cookie: state.cookies[role],
      body: { sectionId: "refund", reviewStatus: "confirmed" },
    }), 403, `${role} 复核拒绝`);
  }
  return { reviewerStatus: reviewer.body?.data?.reviewStatus };
});

await step("export-matrix", async () => {
  for (const role of ["admin", "operator", "reviewer"]) {
    const exported = await rawRequest({ path: `/api/jobs/${state.jobId}/export?sections=refund`, cookie: state.cookies[role] });
    if (exported.status !== 200 || exported.buffer.length < 100) throw new Error(`${role} 导出失败：${exported.status}`);
  }
  for (const role of ["config", "readonly"]) {
    const denied = await jsonRequest("GET", `/api/jobs/${state.jobId}/export?sections=refund`, { cookie: state.cookies[role] });
    requireStatus(denied, 403, `${role} 导出拒绝`);
  }
  return { allowed: ["admin", "operator", "reviewer"] };
});

await step("configuration-and-pool", async () => {
  const section = { id: "acceptance-temp", name: "验收临时板块", prompt: "" };
  for (const role of ["operator", "reviewer", "readonly"]) {
    requireStatus(await jsonRequest("POST", "/api/sections", { cookie: state.cookies[role], body: section }), 403, `${role} 配置拒绝`);
  }
  requireStatus(await jsonRequest("POST", "/api/sections", { cookie: state.cookies.config, body: section }), 200, "配置人员建板块");
  requireStatus(await jsonRequest("DELETE", "/api/sections/acceptance-temp", { cookie: state.cookies.config }), 200, "配置人员删板块");
  requireStatus(await jsonRequest("POST", "/api/model-configs", {
    cookie: state.cookies.config,
    body: { name: "acceptance-model", baseUrl: "https://acceptance.example/v1", apiKey: "acceptance-secret-key-123", model: "acceptance", purpose: "text" },
  }), 200, "配置人员建模型");
  const masked = await jsonRequest("GET", "/api/model-configs", { cookie: state.cookies.readonly });
  requireStatus(masked, 200, "只读模型列表");
  if (JSON.stringify(masked.body).includes("acceptance-secret-key-123")) throw new Error("模型响应泄漏 API Key");
  for (const role of ["operator", "readonly"]) {
    requireStatus(await jsonRequest("GET", "/api/model-providers", { cookie: state.cookies[role] }), 403, `${role} 模型池拒绝`);
    requireStatus(await jsonRequest("PATCH", "/api/model-pool-settings", { cookie: state.cookies[role], body: { paidDailyTokenLimit: 10 } }), 403, `${role} 池设置拒绝`);
  }
  requireStatus(await jsonRequest("GET", "/api/model-providers", { cookie: state.cookies.config }), 200, "配置人员服务商列表");
  requireStatus(await jsonRequest("PATCH", "/api/model-pool-settings", { cookie: state.cookies.config, body: { paidDailyTokenLimit: 500 } }), 200, "配置人员池设置");
  return { configWrites: "config/admin only" };
});

await step("analysis-lifecycle", async () => {
  for (const role of ["config", "reviewer", "readonly"]) {
    requireStatus(await jsonRequest("POST", `/api/jobs/${state.jobId}/pause`, { cookie: state.cookies[role] }), 403, `${role} 暂停拒绝`);
    requireStatus(await jsonRequest("POST", `/api/jobs/${state.jobId}/cancel`, { cookie: state.cookies[role] }), 403, `${role} 取消拒绝`);
    requireStatus(await jsonRequest("POST", `/api/jobs/${state.jobId}/analyze`, { cookie: state.cookies[role], body: { sectionId: "refund" } }), 403, `${role} 解析拒绝`);
  }
  requireStatus(await jsonRequest("POST", `/api/jobs/${state.jobId}/pause`, { cookie: state.cookies.operator }), 200, "操作人员暂停");
  requireStatus(await jsonRequest("POST", `/api/jobs/${state.jobId}/cancel`, { cookie: state.cookies.operator }), 200, "操作人员取消");
  const started = await jsonRequest("POST", `/api/jobs/${state.jobId}/analyze`, { cookie: state.cookies.operator, body: { sectionId: "refund" } });
  requireStatus(started, 200, "操作人员发起解析");
  await waitFor(async () => {
    const job = await jsonRequest("GET", `/api/jobs/${state.jobId}`, { cookie: state.cookies.operator });
    return job.body?.data?.status !== "processing" ? true : undefined;
  }, 90_000, "解析运行结束");
  return { startedBy: "operator" };
});

await step("account-disable", async () => {
  const created = await jsonRequest("POST", "/api/admin/users", {
    cookie: state.cookies.admin,
    body: { username: "acceptance-temp", password: "acceptance-temp-123", displayName: "临时账号", role: "operator" },
  });
  requireStatus(created, 200, "创建临时账号");
  const session = await login("acceptance-temp", "acceptance-temp-123");
  requireStatus(session, 200, "临时账号登录");
  requireStatus(await jsonRequest("PATCH", `/api/admin/users/${created.body.data.id}`, { cookie: state.cookies.admin, body: { isEnabled: false } }), 200, "停用临时账号");
  requireStatus(await jsonRequest("GET", "/api/jobs", { cookie: session.cookie }), 401, "停用后会话失效");
  return { disabledUser: created.body.data.id };
});

await step("backup-through-api", async () => {
  const backup = await jsonRequest("POST", "/api/admin/backups", { cookie: state.cookies.admin });
  requireStatus(backup, 200, "创建备份");
  state.backupName = backup.body.data.name;
  return { name: state.backupName, files: backup.body.data.files, references: backup.body.data.references };
});

await step("audit-trail", async () => {
  const audit = await jsonRequest("GET", "/api/admin/audit-events?limit=200", { cookie: state.cookies.admin });
  requireStatus(audit, 200, "审计查询");
  const events = audit.body.data.items;
  state.auditEvents = events;
  const required = [
    "auth.login",
    "identity.create_user",
    "identity.update_user",
    "task.import",
    "task.pause",
    "task.cancel",
    "task.start_analysis",
    "review.save",
    "task.export",
    "config.upsert_section",
    "config.create_model",
    "pool.update_settings",
    "backup.create",
  ];
  const actions = new Set(events.map((event) => event.action));
  const missing = required.filter((action) => !actions.has(action));
  if (missing.length) throw new Error(`缺少审计动作：${missing.join(", ")}`);
  const failures = events.filter((event) => event.outcome === "failure");
  if (!failures.length) throw new Error("缺少拒绝审计事件");
  const reviewEvent = events.find((event) => event.action === "review.save" && event.outcome === "success");
  if (reviewEvent?.correlationId !== "acceptance-review-1") {
    throw new Error(`复核审计缺少请求关联标识：${JSON.stringify(reviewEvent?.correlationId)}`);
  }
  for (const event of events) {
    if (!event.actorDisplay || !event.occurredAt || !event.outcome || !event.action) throw new Error("审计事件字段不完整");
  }
  const serialized = JSON.stringify(events);
  for (const secret of SECRETS) {
    if (serialized.includes(secret)) throw new Error(`审计泄漏敏感值：${secret}`);
  }
  return { events: events.length, failures: failures.length, actions: [...actions].length };
});

const ok = steps.every((item) => item.ok);
console.log(JSON.stringify({ ok, host: HOST, origin: ORIGIN, steps, backupName: state.backupName, auditEventCount: state.auditEvents.length }, null, 2));
process.exitCode = ok ? 0 : 1;
