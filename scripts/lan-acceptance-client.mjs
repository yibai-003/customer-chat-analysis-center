// LAN release acceptance client. Runs on a workstation against the internal HTTPS
// entry and exercises the five-role permission matrix, shared data, audit trail and
// administrator-only operations. `ACCEPTANCE_TLS_VERIFY=true` enforces the real
// internal certificate (required for field acceptance); the default accepts the
// drill's self-signed certificate. Output is machine-readable JSON.
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import crypto from "node:crypto";

const HOST = process.env.ACCEPTANCE_HOST ?? "chat.example.lan";
const PORT = Number(process.env.ACCEPTANCE_PORT ?? 8443);
const CONNECT_HOST = process.env.ACCEPTANCE_CONNECT_HOST ?? HOST;
const TLS_VERIFY = process.env.ACCEPTANCE_TLS_VERIFY === "true";
const ORIGIN = process.env.ACCEPTANCE_ORIGIN ?? `https://${HOST}`;
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
// Real model provider credentials. When provided, the client configures and verifies
// the models through the API and proves a real model call completed an analysis. The
// API key only ever leaves the workstation as the create request body; it is never
// written to evidence or echoed back by the assertions below.
const MODEL = {
  baseUrl: process.env.ACCEPTANCE_MODEL_BASE_URL ?? "",
  apiKey: process.env.ACCEPTANCE_MODEL_API_KEY ?? "",
  visionModel: process.env.ACCEPTANCE_MODEL_NAME ?? "",
  textModel: process.env.ACCEPTANCE_TEXT_MODEL_NAME || process.env.ACCEPTANCE_MODEL_NAME || "",
  supportsVision: process.env.ACCEPTANCE_MODEL_SUPPORTS_VISION !== "false",
};
const REAL_MODEL = Boolean(MODEL.baseUrl && MODEL.apiKey && MODEL.visionModel && MODEL.textModel);
const SECRETS = [ADMIN.password, ...ACCOUNTS.map((account) => account.password), "acceptance-secret-key-123", "password_hash", "cc_sid", ...(REAL_MODEL ? [MODEL.apiKey] : [])];

const steps = [];
const state = { cookies: {}, jobId: "", recordId: "", backupName: "", auditEvents: [], models: {} };

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
      host: CONNECT_HOST,
      port: PORT,
      method,
      path: requestPath,
      servername: HOST,
      rejectUnauthorized: TLS_VERIFY,
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
        certificate: response.socket?.getPeerCertificate?.() ?? null,
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
  return { status: response.status, body, headers: response.headers, certificate: response.certificate };
}

function certificateEvidence(certificate) {
  if (!certificate || !certificate.subject) return null;
  return {
    subject: certificate.subject?.CN ?? null,
    issuer: certificate.issuer?.CN ?? null,
    validFrom: certificate.valid_from ?? null,
    validTo: certificate.valid_to ?? null,
    fingerprint256: certificate.fingerprint256 ?? null,
  };
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
  return {
    status: response.body.data.status,
    entry: { host: HOST, port: PORT, origin: ORIGIN, tlsVerified: TLS_VERIFY },
    certificate: certificateEvidence(response.certificate),
  };
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
    if (created.status !== 200) {
      const session = await login(account.username, account.password);
      if (session.status !== 200 || !session.cookie) {
        throw new Error(`${account.role} 创建失败（${created.status}）且无法用既定验收账号登录（${session.status}）：${JSON.stringify(created.body).slice(0, 200)}`);
      }
      state.cookies[account.role] = session.cookie;
      continue;
    }
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

await step("real-model-configure", async () => {
  if (!REAL_MODEL) {
    return { skipped: true, reason: "未提供 ACCEPTANCE_MODEL_BASE_URL/API_KEY/NAME，跳过真实模型配置" };
  }
  const prior = await jsonRequest("GET", "/api/model-configs", { cookie: state.cookies.config });
  for (const model of prior.body?.data ?? []) {
    if (model.name === "验收视觉模型" || model.name === "验收文本模型") {
      await jsonRequest("DELETE", `/api/model-configs/${model.id}`, { cookie: state.cookies.config });
    }
  }
  const quotaExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const created = {};
  for (const [purpose, model] of [["vision", MODEL.visionModel], ["text", MODEL.textModel]]) {
    const response = await jsonRequest("POST", "/api/model-configs", {
      cookie: state.cookies.config,
      body: {
        name: `验收${purpose === "vision" ? "视觉" : "文本"}模型`,
        baseUrl: MODEL.baseUrl,
        apiKey: MODEL.apiKey,
        model,
        purpose,
        supportsVision: purpose === "vision" && MODEL.supportsVision,
      },
    });
    requireStatus(response, 200, `创建${purpose}模型`);
    created[purpose] = response.body.data.id;
  }
  for (const purpose of ["vision", "text"]) {
    requireStatus(await jsonRequest("POST", `/api/model-configs/${created[purpose]}/default`, {
      cookie: state.cookies.config,
      body: { purpose },
    }), 200, `设为默认${purpose}模型`);
    const tested = await jsonRequest("POST", `/api/model-configs/${created[purpose]}/test`, { cookie: state.cookies.config });
    requireStatus(tested, 200, `${purpose}模型连通性`);
    if (tested.body?.data?.success !== true) throw new Error(`${purpose}模型连通性检测未通过`);
  }
  const verified = await jsonRequest("POST", "/api/model-pool-members/verify", {
    cookie: state.cookies.config,
    body: { ids: [created.vision, created.text], enablePassed: true },
  });
  requireStatus(verified, 200, "模型能力验证");
  const failing = (verified.body.data ?? []).filter((item) => !item.passed);
  if (failing.length) throw new Error(`模型能力验证未通过：${JSON.stringify(failing).slice(0, 300)}`);
  for (const purpose of ["vision", "text"]) {
    requireStatus(await jsonRequest("PATCH", `/api/model-pool-members/${created[purpose]}`, {
      cookie: state.cookies.config,
      body: { poolEnabled: true, billingMode: "free", quotaTotalTokens: 1_000_000, quotaExpiresAt },
    }), 200, `${purpose}模型池配置`);
  }
  const listed = await jsonRequest("GET", "/api/model-configs", { cookie: state.cookies.readonly });
  requireStatus(listed, 200, "只读模型列表");
  if (JSON.stringify(listed.body).includes(MODEL.apiKey)) throw new Error("模型配置响应泄漏真实 API Key");
  state.models = created;
  return {
    configured: true,
    vision: created.vision,
    text: created.text,
    visionModel: MODEL.visionModel,
    textModel: MODEL.textModel,
    supportsVision: MODEL.supportsVision,
    verified: (verified.body.data ?? []).map((item) => ({ purpose: item.purpose, passed: item.passed, capabilities: item.capabilities })),
  };
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

await step("real-model-parse", async () => {
  if (!REAL_MODEL) {
    return { skipped: true, reason: "未提供真实模型，无法验证模型解析闭环" };
  }
  const sectionId = `acceptance-model-${Date.now().toString(36)}`;
  const fieldKey = "acceptanceConclusion";
  requireStatus(await jsonRequest("POST", "/api/sections", {
    cookie: state.cookies.config,
    body: { id: sectionId, name: "验收模型解析", prompt: "验收专用板块：用一句话给出结论。" },
  }), 200, "创建验收解析板块");
  requireStatus(await jsonRequest("POST", `/api/sections/${sectionId}/fields`, {
    cookie: state.cookies.config,
    body: { key: fieldKey, label: "验收结论", type: "string", prompt: "请用一句话给出客服聊天结论。", required: true, imageEnabled: false },
  }), 200, "创建验收解析字段");
  try {
    const upload = multipart(SAMPLE, { sectionId });
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
      throw new Error(`验收解析导入失败：${imported.status} ${JSON.stringify(created).slice(0, 200)}`);
    }
    const finished = await waitFor(async () => {
      const status = await jsonRequest("GET", `/api/import-jobs/${created.data.id}`, { cookie: state.cookies.operator });
      return status.body?.data && ["completed", "failed"].includes(status.body.data.status) ? status.body.data : undefined;
    }, 90_000, "验收解析导入");
    if (finished.status !== "completed") throw new Error(`验收解析导入状态 ${finished.status}：${finished.errorMessage ?? ""}`);
    const records = await jsonRequest("GET", `/api/jobs/${finished.jobId}/records?page=1&pageSize=1`, { cookie: state.cookies.operator });
    const recordId = records.body?.data?.items?.[0]?.id;
    if (!recordId) throw new Error("验收解析任务没有记录");
    requireStatus(await jsonRequest("POST", `/api/records/${recordId}/analyze`, {
      cookie: state.cookies.operator,
      body: { sectionId },
    }), 200, "真实模型单条解析");
    const detail = await jsonRequest("GET", `/api/records/${recordId}`, { cookie: state.cookies.admin });
    requireStatus(detail, 200, "验收解析记录详情");
    const runs = detail.body?.data?.fieldRuns ?? [];
    const modelRun = runs.find((run) => run.fieldKey === fieldKey && run.status === "completed");
    const output = modelRun?.result?.[fieldKey];
    if (!output || typeof output !== "string" || !output.trim()) {
      throw new Error(`字段 ${fieldKey} 未产生模型输出：${JSON.stringify(modelRun?.result ?? null).slice(0, 200)}`);
    }
    const usage = await jsonRequest(
      "GET",
      `/api/model-usage-events?modelConfigId=${state.models.text}&eventType=success&limit=50`,
      { cookie: state.cookies.config },
    );
    requireStatus(usage, 200, "模型调用用量");
    const events = usage.body?.data ?? [];
    if (!events.length) throw new Error("未记录到真实文本模型调用成功事件");
    const serialized = JSON.stringify(detail.body) + JSON.stringify(usage.body);
    if (serialized.includes(MODEL.apiKey)) throw new Error("解析结果或用量事件泄漏真实 API Key");
    const tokens = events.reduce((sum, event) => sum + (event.inputTokens ?? 0) + (event.outputTokens ?? 0), 0);
    return {
      recordStatus: detail.body?.data?.status,
      modelField: fieldKey,
      outputPreview: output.slice(0, 60),
      modelCalls: events.length,
      accountedTokens: tokens,
    };
  } finally {
    const fields = await jsonRequest("GET", `/api/sections/${sectionId}/fields`, { cookie: state.cookies.config });
    for (const field of fields.body?.data ?? []) {
      await jsonRequest("DELETE", `/api/fields/${field.id}`, { cookie: state.cookies.config });
    }
    await jsonRequest("DELETE", `/api/sections/${sectionId}`, { cookie: state.cookies.config });
  }
});

await step("account-disable", async () => {
  const username = `acceptance-temp-${Date.now().toString(36)}`;
  const password = "acceptance-temp-123";
  const created = await jsonRequest("POST", "/api/admin/users", {
    cookie: state.cookies.admin,
    body: { username, password, displayName: "临时账号", role: "operator" },
  });
  requireStatus(created, 200, "创建临时账号");
  const session = await login(username, password);
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
    ...(REAL_MODEL ? ["config.test_model", "config.set_default_model", "pool.verify"] : []),
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
const modelStep = steps.find((item) => item.name === "real-model-parse");
console.log(JSON.stringify({ ok, host: HOST, port: PORT, origin: ORIGIN, tlsVerified: TLS_VERIFY, realModel: REAL_MODEL, modelEvidence: modelStep?.detail ?? null, steps, backupName: state.backupName, auditEventCount: state.auditEvents.length }, null, 2));
process.exitCode = ok ? 0 : 1;
