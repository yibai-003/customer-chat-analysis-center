// LAN release acceptance client. Runs on a workstation against the internal HTTPS
// entry and exercises the five-role permission matrix, shared data, audit trail and
// administrator-only operations. `ACCEPTANCE_TLS_VERIFY=true` enforces the real
// internal certificate (required for field acceptance); the default accepts the
// drill's self-signed certificate. Output is machine-readable JSON.
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import {
  acceptanceModelConfiguration,
  containsConfiguredSecret,
  createAcceptanceAccounts,
  modelEndpointEvidence,
  shouldCreateCredentialProbe,
  signoffEligibility,
  validateSignoffSampleCount,
} from "./lan-acceptance-policy.mjs";

const HOST = process.env.ACCEPTANCE_HOST ?? "chat.example.lan";
const PORT = Number(process.env.ACCEPTANCE_PORT ?? 8443);
const CONNECT_HOST = process.env.ACCEPTANCE_CONNECT_HOST ?? HOST;
const TLS_VERIFY = process.env.ACCEPTANCE_TLS_VERIFY === "true";
const MODE = process.env.ACCEPTANCE_MODE === "signoff" ? "signoff" : "drill";
const SIGNOFF = MODE === "signoff";
const DNS_CHECKED = process.env.ACCEPTANCE_DNS_CHECKED === "true";
const CROSS_MACHINE = process.env.ACCEPTANCE_CROSS_MACHINE === "true";
const RUN_ID = process.env.ACCEPTANCE_RUN_ID
  ?? `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
const ORIGIN = process.env.ACCEPTANCE_ORIGIN ?? `https://${HOST}`;
const SAMPLE = process.env.ACCEPTANCE_SAMPLE ?? "sample-chat.xlsx";
const ADMIN = {
  username: process.env.ACCEPTANCE_ADMIN_USERNAME ?? "admin",
  password: process.env.ACCEPTANCE_ADMIN_PASSWORD ?? "",
};
const ACCOUNTS = createAcceptanceAccounts(RUN_ID);
// Formal sign-off references a provider already configured on the host, so its API
// key never reaches the workstation. Drill mode may use a temporary workstation key.
const MODEL = {
  providerName: process.env.ACCEPTANCE_MODEL_PROVIDER ?? "",
  baseUrl: process.env.ACCEPTANCE_MODEL_BASE_URL ?? "",
  apiKey: process.env.ACCEPTANCE_MODEL_API_KEY ?? "",
  visionModel: process.env.ACCEPTANCE_MODEL_NAME ?? "",
  textModel: process.env.ACCEPTANCE_TEXT_MODEL_NAME || process.env.ACCEPTANCE_MODEL_NAME || "",
  supportsVision: process.env.ACCEPTANCE_MODEL_SUPPORTS_VISION !== "false",
};
const MODEL_CONFIGURATION = acceptanceModelConfiguration({ ...MODEL, signoff: SIGNOFF });
const REAL_MODEL = MODEL_CONFIGURATION.configured;
const MODEL_ENDPOINT = {
  ...modelEndpointEvidence(MODEL.baseUrl),
  providerName: MODEL.providerName,
  credentialSource: MODEL_CONFIGURATION.credentialSource,
};
const SECRETS = [
  ADMIN.password,
  ...ACCOUNTS.map((account) => account.password),
  "acceptance-secret-key-123",
  "password_hash",
  "cc_sid",
  ...(MODEL.apiKey ? [MODEL.apiKey] : []),
].filter(Boolean);

const steps = [];
const state = {
  cookies: {},
  jobId: "",
  recordId: "",
  backupName: "",
  auditEvents: [],
  models: {},
  createdUserIds: [],
  createdModelIds: [],
  createdProviderIds: [],
  priorDefaults: {},
  priorPoolSettings: null,
  signoff: {
    importedRecords: 0,
    parsedRecords: 0,
    reviewed: false,
    exported: false,
    backupCreated: false,
    restoreVerified: false,
    crossMachine: CROSS_MACHINE,
  },
};

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

function preflightFailure(reason) {
  const signoff = signoffEligibility({
    tlsVerified: TLS_VERIFY,
    dnsChecked: DNS_CHECKED,
    model: MODEL_ENDPOINT,
    importedRecords: 0,
    parsedRecords: 0,
    reviewed: false,
    exported: false,
    backupCreated: false,
    restoreVerified: false,
    crossMachine: CROSS_MACHINE,
  });
  console.log(JSON.stringify({
    ok: false,
    mode: MODE,
    host: HOST,
    port: PORT,
    origin: ORIGIN,
    tlsVerified: TLS_VERIFY,
    realModel: REAL_MODEL,
    modelEndpoint: MODEL_ENDPOINT,
    signoff,
    steps: [{ name: "preflight", ok: false, detail: reason }],
  }, null, 2));
  process.exit(1);
}

if (!ADMIN.password) preflightFailure("必须通过 ACCEPTANCE_ADMIN_PASSWORD 提供管理员密码");
if (!fs.existsSync(SAMPLE)) preflightFailure(`验收样本不存在：${SAMPLE}`);
if (SIGNOFF) {
  const missing = [];
  if (!TLS_VERIFY) missing.push("受信 TLS");
  if (!DNS_CHECKED) missing.push("内网 DNS 检查");
  if (!CROSS_MACHINE) missing.push("第二台物理工作站");
  if (MODEL_CONFIGURATION.credentialSource === "forbidden") {
    missing.push("禁止工作站传入模型 API Key");
  } else if (!REAL_MODEL || !MODEL_ENDPOINT.signable) {
    missing.push("公网/正式 HTTPS 模型供应商");
  }
  if (!MODEL.providerName.trim()) missing.push("模型供应商名称");
  if (missing.length) preflightFailure(`正式签收前置条件不满足：${missing.join("、")}`);
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
    requireStatus(created, 200, `${account.role} 创建唯一验收账号`);
    state.createdUserIds.push(created.body.data.id);
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
  const suffix = RUN_ID.replace(/[^a-z0-9-]/gi, "").slice(0, 32);
  const section = { id: `acceptance-temp-${suffix}`, name: `验收临时板块 ${suffix}`, prompt: "" };
  for (const role of ["operator", "reviewer", "readonly"]) {
    requireStatus(await jsonRequest("POST", "/api/sections", { cookie: state.cookies[role], body: section }), 403, `${role} 配置拒绝`);
  }
  requireStatus(await jsonRequest("POST", "/api/sections", { cookie: state.cookies.config, body: section }), 200, "配置人员建板块");
  requireStatus(await jsonRequest("DELETE", `/api/sections/${section.id}`, { cookie: state.cookies.config }), 200, "配置人员删板块");
  const providersBefore = await jsonRequest("GET", "/api/model-providers", { cookie: state.cookies.config });
  requireStatus(providersBefore, 200, "读取验收前供应商");
  if (shouldCreateCredentialProbe(SIGNOFF)) {
    const createdModel = await jsonRequest("POST", "/api/model-configs", {
      cookie: state.cookies.config,
      body: {
        name: `acceptance-model-${suffix}`,
        baseUrl: "https://acceptance.example/v1",
        apiKey: "acceptance-secret-key-123",
        model: "acceptance",
        purpose: "text",
      },
    });
    requireStatus(createdModel, 200, "配置人员建模型");
    state.createdModelIds.push(createdModel.body.data.id);
    const knownProviders = new Set((providersBefore.body?.data ?? []).map((item) => item.id));
    if (createdModel.body.data.providerId && !knownProviders.has(createdModel.body.data.providerId)) {
      state.createdProviderIds.push(createdModel.body.data.providerId);
    }
  }
  const masked = await jsonRequest("GET", "/api/model-configs", { cookie: state.cookies.readonly });
  requireStatus(masked, 200, "只读模型列表");
  if (containsConfiguredSecret(JSON.stringify(masked.body), "acceptance-secret-key-123")) {
    throw new Error("模型响应泄漏 API Key");
  }
  for (const role of ["operator", "readonly"]) {
    requireStatus(await jsonRequest("GET", "/api/model-providers", { cookie: state.cookies[role] }), 403, `${role} 模型池拒绝`);
    requireStatus(await jsonRequest("PATCH", "/api/model-pool-settings", { cookie: state.cookies[role], body: { paidDailyTokenLimit: 10 } }), 403, `${role} 池设置拒绝`);
  }
  requireStatus(await jsonRequest("GET", "/api/model-providers", { cookie: state.cookies.config }), 200, "配置人员服务商列表");
  const settings = await jsonRequest("GET", "/api/model-pool-settings", { cookie: state.cookies.config });
  requireStatus(settings, 200, "读取模型池设置");
  state.priorPoolSettings = settings.body.data;
  requireStatus(await jsonRequest("PATCH", "/api/model-pool-settings", { cookie: state.cookies.config, body: { paidDailyTokenLimit: 500 } }), 200, "配置人员池设置");
  return {
    configWrites: "config/admin only",
    credentialProbe: shouldCreateCredentialProbe(SIGNOFF) ? "temporary-drill-model" : "host-provider-only",
  };
});

await step("real-model-configure", async () => {
  if (!REAL_MODEL) {
    return { skipped: true, reason: `模型配置不完整：${MODEL_CONFIGURATION.missing.join(", ")}` };
  }
  const prior = await jsonRequest("GET", "/api/model-configs", { cookie: state.cookies.config });
  requireStatus(prior, 200, "读取验收前模型配置");
  for (const purpose of ["vision", "text"]) {
    const currentDefault = (prior.body?.data ?? []).find((item) => item.purpose === purpose && item.isPurposeDefault);
    state.priorDefaults[purpose] = currentDefault?.id ?? null;
  }
  const providers = await jsonRequest("GET", "/api/model-providers", { cookie: state.cookies.config });
  requireStatus(providers, 200, "读取模型供应商");
  const knownProviderIds = new Set((providers.body?.data ?? []).map((item) => item.id));
  const normalizedBaseUrl = MODEL.baseUrl.replace(/\/+$/, "");
  const provider = (providers.body?.data ?? []).find((item) =>
    item.baseUrl?.replace(/\/+$/, "") === normalizedBaseUrl
    && (!SIGNOFF || item.name === MODEL.providerName)
  );
  if (SIGNOFF && !provider) {
    throw new Error(`正式签收要求预先配置名称为“${MODEL.providerName}”且地址匹配的模型供应商`);
  }
  const quotaExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const created = {};
  for (const [purpose, model] of [["vision", MODEL.visionModel], ["text", MODEL.textModel]]) {
    const response = await jsonRequest("POST", "/api/model-configs", {
      cookie: state.cookies.config,
      body: {
        name: `验收${purpose === "vision" ? "视觉" : "文本"}模型 ${RUN_ID}`,
        baseUrl: MODEL.baseUrl,
        ...(SIGNOFF ? { providerId: provider.id } : { apiKey: MODEL.apiKey }),
        model,
        purpose,
        supportsVision: purpose === "vision" && MODEL.supportsVision,
      },
    });
    requireStatus(response, 200, `创建${purpose}模型`);
    created[purpose] = response.body.data.id;
    state.createdModelIds.push(response.body.data.id);
    if (response.body.data.providerId && !knownProviderIds.has(response.body.data.providerId)
      && !state.createdProviderIds.includes(response.body.data.providerId)) {
      state.createdProviderIds.push(response.body.data.providerId);
    }
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
  if (containsConfiguredSecret(JSON.stringify(listed.body), MODEL.apiKey)) {
    throw new Error("模型配置响应泄漏真实 API Key");
  }
  state.models = created;
  return {
    configured: true,
    vision: created.vision,
    text: created.text,
    visionModel: MODEL.visionModel,
    textModel: MODEL.textModel,
    supportsVision: MODEL.supportsVision,
    credentialSource: MODEL_CONFIGURATION.credentialSource,
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
    const importedJob = await jsonRequest("GET", `/api/jobs/${finished.jobId}`, { cookie: state.cookies.operator });
    requireStatus(importedJob, 200, "读取验收解析任务");
    const importedRecords = Number(importedJob.body?.data?.totalRecords ?? 0);
    if (SIGNOFF) validateSignoffSampleCount(importedRecords);
    state.signoff.importedRecords = importedRecords;
    const pageSize = Math.max(importedRecords, 1);
    const records = await jsonRequest(
      "GET",
      `/api/jobs/${finished.jobId}/records?page=1&pageSize=${pageSize}`,
      { cookie: state.cookies.operator },
    );
    requireStatus(records, 200, "读取验收解析记录");
    const recordItems = records.body?.data?.items ?? [];
    const record = recordItems[0];
    const recordId = record?.id;
    if (!recordId) throw new Error("验收解析任务没有记录");
    if (SIGNOFF && recordItems.length !== importedRecords) {
      throw new Error(`验收解析记录分页不完整：读取 ${recordItems.length}，应为 ${importedRecords}`);
    }
    if (SIGNOFF) {
      requireStatus(await jsonRequest("POST", `/api/jobs/${finished.jobId}/analyze`, {
        cookie: state.cookies.operator,
        body: { sectionId },
      }), 200, "真实模型批量解析");
      const completedJob = await waitFor(async () => {
        const job = await jsonRequest("GET", `/api/jobs/${finished.jobId}`, { cookie: state.cookies.operator });
        if (job.status !== 200) return undefined;
        const data = job.body?.data;
        const accounted = Number(data?.completedRecords ?? 0) + Number(data?.failedRecords ?? 0);
        return data?.status !== "processing" && accounted >= importedRecords ? data : undefined;
      }, 30 * 60_000, "真实模型批量解析");
      if (completedJob.failedRecords !== 0 || completedJob.completedRecords !== importedRecords) {
        throw new Error(`真实模型批量解析未全部成功：完成 ${completedJob.completedRecords}/${importedRecords}，失败 ${completedJob.failedRecords}`);
      }
      state.signoff.parsedRecords = completedJob.completedRecords;
    } else {
      requireStatus(await jsonRequest("POST", `/api/records/${recordId}/analyze`, {
        cookie: state.cookies.operator,
        body: { sectionId },
      }), 200, "真实模型单条解析");
      state.signoff.parsedRecords = 1;
    }
    const verifiedRecords = [];
    for (const item of recordItems) {
      const detail = await jsonRequest("GET", `/api/records/${item.id}`, { cookie: state.cookies.admin });
      requireStatus(detail, 200, `读取验收记录详情 ${item.id}`);
      if (SIGNOFF && detail.body?.data?.status !== "completed") {
        throw new Error(`验收记录 ${item.id} 未完成：${detail.body?.data?.status}`);
      }
      const runs = detail.body?.data?.fieldRuns ?? [];
      const modelRun = runs.find((run) => run.fieldKey === fieldKey && run.status === "completed");
      const output = modelRun?.result?.[fieldKey];
      if (!output || typeof output !== "string" || !output.trim()) {
        throw new Error(`记录 ${item.id} 的字段 ${fieldKey} 未产生模型输出`);
      }
      verifiedRecords.push({ record: item, detail, output });
    }
    const primary = verifiedRecords[0];
    const detail = primary.detail;
    const output = primary.output;
    const reviewTargets = SIGNOFF ? verifiedRecords : [primary];
    for (const target of reviewTargets) {
      const reviewed = await jsonRequest("PATCH", `/api/records/${target.record.id}`, {
        cookie: state.cookies.reviewer,
        headers: { "x-request-id": `acceptance-model-review-${RUN_ID}` },
        body: {
          sectionId,
          humanResult: { [fieldKey]: target.output },
          reviewStatus: "confirmed",
          reviewNote: `LAN acceptance ${RUN_ID}`,
          status: "completed",
        },
      });
      requireStatus(reviewed, 200, `真实模型结果复核 ${target.record.id}`);
      if (reviewed.body?.data?.reviewStatus !== "confirmed") {
        throw new Error(`真实模型结果未进入已复核状态：${target.record.id}`);
      }
    }
    state.signoff.reviewed = reviewTargets.length === verifiedRecords.length;

    const exported = await rawRequest({
      path: `/api/jobs/${finished.jobId}/export?sections=${encodeURIComponent(sectionId)}`,
      cookie: state.cookies.reviewer,
    });
    if (exported.status !== 200 || exported.buffer.length < 100) {
      throw new Error(`真实模型任务导出失败：${exported.status}`);
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.buffer);
    const worksheet = workbook.getWorksheet(record.sheetName) ?? workbook.worksheets[0];
    const headers = (worksheet?.getRow(1).values ?? []).map((value) => String(value ?? "")).filter(Boolean);
    for (const expected of ["解析状态", "复核状态", "复核备注"]) {
      if (!headers.includes(expected)) throw new Error(`导出缺少验收列：${expected}`);
    }
    if (!headers.some((header) => header.endsWith("验收结论"))) {
      throw new Error(`导出缺少模型字段“验收结论”：${JSON.stringify(headers).slice(0, 400)}`);
    }
    const sourceKeys = Object.keys(detail.body?.data?.sourceFields ?? {});
    if (sourceKeys.length && !sourceKeys.some((key) => headers.includes(key))) {
      throw new Error("导出文件未保留任何原始字段");
    }
    const values = Object.fromEntries(headers.map((header, index) => [
      header,
      String(worksheet.getRow(record.rowNumber).getCell(index + 1).value ?? ""),
    ]));
    const modelHeader = headers.find((header) => header.endsWith("验收结论"));
    if (!modelHeader || values[modelHeader] !== output) throw new Error("导出文件中的模型结果与复核结果不一致");
    if (values["解析状态"] !== "completed") throw new Error(`导出解析状态异常：${values["解析状态"]}`);
    if (values["复核状态"] !== "confirmed") throw new Error(`导出复核状态异常：${values["复核状态"]}`);
    if (!values["复核备注"].includes(RUN_ID)) throw new Error("导出复核备注缺少本次验收标识");
    if (SIGNOFF) {
      for (const target of verifiedRecords) {
        const targetSheet = workbook.getWorksheet(target.record.sheetName);
        if (!targetSheet) throw new Error(`导出缺少工作表：${target.record.sheetName}`);
        const targetValues = Object.fromEntries(headers.map((header, index) => [
          header,
          String(targetSheet.getRow(target.record.rowNumber).getCell(index + 1).value ?? ""),
        ]));
        if (targetValues["解析状态"] !== "completed") {
          throw new Error(`记录 ${target.record.id} 导出解析状态异常`);
        }
        if (targetValues["复核状态"] !== "confirmed" || !targetValues["复核备注"].includes(RUN_ID)) {
          throw new Error(`记录 ${target.record.id} 导出复核状态异常`);
        }
        if (targetValues[modelHeader] !== target.output) {
          throw new Error(`记录 ${target.record.id} 导出模型结果不一致`);
        }
      }
    }
    state.signoff.exported = true;

    const usage = await jsonRequest(
      "GET",
      `/api/model-usage-events?modelConfigId=${state.models.text}&eventType=success&limit=50`,
      { cookie: state.cookies.config },
    );
    requireStatus(usage, 200, "模型调用用量");
    const events = usage.body?.data ?? [];
    if (!events.length) throw new Error("未记录到真实文本模型调用成功事件");
    const serialized = JSON.stringify(detail.body) + JSON.stringify(usage.body);
    if (containsConfiguredSecret(serialized, MODEL.apiKey)) {
      throw new Error("解析结果或用量事件泄漏真实 API Key");
    }
    const tokens = events.reduce((sum, event) => sum + (event.inputTokens ?? 0) + (event.outputTokens ?? 0), 0);
    return {
      recordStatus: detail.body?.data?.status,
      modelField: fieldKey,
      outputPreview: output.slice(0, 60),
      modelCalls: events.length,
      accountedTokens: tokens,
      importedRecords,
      parsedRecords: state.signoff.parsedRecords,
      recordsVerified: verifiedRecords.length,
      reviewed: state.signoff.reviewed,
      exported: state.signoff.exported,
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
  const username = `acceptance-temp-${RUN_ID}`.replace(/[^a-z0-9-]/gi, "").slice(0, 64);
  const password = crypto.randomBytes(18).toString("base64url");
  SECRETS.push(password);
  const created = await jsonRequest("POST", "/api/admin/users", {
    cookie: state.cookies.admin,
    body: { username, password, displayName: "临时账号", role: "operator" },
  });
  requireStatus(created, 200, "创建临时账号");
  state.createdUserIds.push(created.body.data.id);
  const session = await login(username, password);
  requireStatus(session, 200, "临时账号登录");
  requireStatus(await jsonRequest("PATCH", `/api/admin/users/${created.body.data.id}`, { cookie: state.cookies.admin, body: { isEnabled: false } }), 200, "停用临时账号");
  requireStatus(await jsonRequest("GET", "/api/jobs", { cookie: session.cookie }), 401, "停用后会话失效");
  return { disabledUser: created.body.data.id };
});

await step("restore-acceptance-state", async () => {
  const failures = [];
  const attempt = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  for (const purpose of ["vision", "text"]) {
    if (!Object.hasOwn(state.priorDefaults, purpose)) continue;
    const priorId = state.priorDefaults[purpose];
    await attempt(`恢复${purpose}默认模型`, async () => {
      if (priorId && !state.createdModelIds.includes(priorId)) {
        requireStatus(await jsonRequest("POST", `/api/model-configs/${priorId}/default`, {
          cookie: state.cookies.admin,
          body: { purpose },
        }), 200, `恢复${purpose}默认模型`);
      } else {
        requireStatus(await jsonRequest("DELETE", `/api/model-configs/default/${purpose}`, {
          cookie: state.cookies.admin,
        }), 200, `清空${purpose}默认模型`);
      }
    });
  }
  if (state.priorPoolSettings) {
    await attempt("恢复模型池设置", async () => {
      requireStatus(await jsonRequest("PATCH", "/api/model-pool-settings", {
        cookie: state.cookies.admin,
        body: state.priorPoolSettings,
      }), 200, "恢复模型池设置");
    });
  }
  for (const modelId of [...state.createdModelIds].reverse()) {
    await attempt(`删除验收模型 ${modelId}`, async () => {
      requireStatus(await jsonRequest("DELETE", `/api/model-configs/${modelId}`, {
        cookie: state.cookies.admin,
      }), 200, `删除验收模型 ${modelId}`);
    });
  }
  for (const providerId of state.createdProviderIds) {
    await attempt(`删除验收临时供应商 ${providerId}`, async () => {
      requireStatus(await jsonRequest("DELETE", `/api/model-providers/${providerId}`, {
        cookie: state.cookies.admin,
      }), 200, `删除验收临时供应商 ${providerId}`);
    });
  }
  for (const userId of state.createdUserIds) {
    await attempt(`停用验收账号 ${userId}`, async () => {
      requireStatus(await jsonRequest("PATCH", `/api/admin/users/${userId}`, {
        cookie: state.cookies.admin,
        body: { isEnabled: false },
      }), 200, `停用验收账号 ${userId}`);
    });
  }

  const models = await jsonRequest("GET", "/api/model-configs", { cookie: state.cookies.admin });
  requireStatus(models, 200, "验证验收模型已清理");
  const remainingModelIds = new Set((models.body?.data ?? []).map((item) => item.id));
  if (state.createdModelIds.some((id) => remainingModelIds.has(id))) failures.push("存在未清理的验收模型配置");
  for (const purpose of ["vision", "text"]) {
    if (!Object.hasOwn(state.priorDefaults, purpose)) continue;
    const expected = state.priorDefaults[purpose];
    const actual = (models.body?.data ?? [])
      .find((item) => item.purpose === purpose && item.isPurposeDefault)?.id ?? null;
    if (actual !== expected) failures.push(`${purpose} 默认模型未恢复：期望 ${expected ?? "无"}，实际 ${actual ?? "无"}`);
  }
  const providers = await jsonRequest("GET", "/api/model-providers", { cookie: state.cookies.admin });
  requireStatus(providers, 200, "验证验收供应商已清理");
  const remainingProviderIds = new Set((providers.body?.data ?? []).map((item) => item.id));
  if (state.createdProviderIds.some((id) => remainingProviderIds.has(id))) failures.push("存在未删除的验收供应商");
  const users = await jsonRequest("GET", "/api/admin/users", { cookie: state.cookies.admin });
  requireStatus(users, 200, "验证验收账号已停用");
  const userById = new Map((users.body?.data ?? []).map((item) => [item.id, item]));
  if (state.createdUserIds.some((id) => userById.get(id)?.isEnabled !== false)) {
    failures.push("存在仍启用的验收账号");
  }
  if (failures.length) {
    throw new Error(`验收状态清理未完成：${failures.join("；")}`);
  }
  return {
    disabledUsers: state.createdUserIds.length,
    removedModels: state.createdModelIds.length,
    removedProviders: state.createdProviderIds.length,
    poolSettingsRestored: Boolean(state.priorPoolSettings),
  };
});

await step("backup-through-api", async () => {
  const cleanup = steps.find((item) => item.name === "restore-acceptance-state");
  if (!cleanup?.ok) throw new Error("验收状态未完整清理，拒绝创建签收备份");
  const backup = await jsonRequest("POST", "/api/admin/backups", { cookie: state.cookies.admin });
  requireStatus(backup, 200, "创建备份");
  state.backupName = backup.body.data.name;
  state.signoff.backupCreated = true;
  return { name: state.backupName, files: backup.body.data.files, references: backup.body.data.references };
});

await step("backup-restore-drill", async () => {
  if (!state.backupName) throw new Error("缺少本次验收备份名称");
  const drilled = await jsonRequest("POST", "/api/admin/backups/drill", {
    cookie: state.cookies.admin,
    body: { name: state.backupName },
  });
  requireStatus(drilled, 200, "同一备份恢复演练");
  if (drilled.body?.data?.backup !== state.backupName || drilled.body?.data?.ok !== true) {
    throw new Error(`恢复演练未验证本次备份：${JSON.stringify(drilled.body?.data).slice(0, 300)}`);
  }
  state.signoff.restoreVerified = true;
  return {
    name: state.backupName,
    checks: (drilled.body.data.checks ?? []).map((check) => ({ name: check.name, ok: check.ok })),
  };
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
    "backup.drill",
    ...(state.createdProviderIds.length ? ["pool.delete_provider"] : []),
    ...(REAL_MODEL ? ["config.test_model", "config.set_default_model", "pool.verify"] : []),
  ];
  const actions = new Set(events.map((event) => event.action));
  const missing = required.filter((action) => !actions.has(action));
  if (missing.length) throw new Error(`缺少审计动作：${missing.join(", ")}`);
  const failures = events.filter((event) => event.outcome === "failure");
  if (!failures.length) throw new Error("缺少拒绝审计事件");
  const reviewCorrelations = new Set(events
    .filter((event) => event.action === "review.save" && event.outcome === "success")
    .map((event) => event.correlationId));
  const requiredReviewCorrelations = [
    "acceptance-review-1",
    ...(REAL_MODEL ? [`acceptance-model-review-${RUN_ID}`] : []),
  ];
  const missingReviewCorrelations = requiredReviewCorrelations.filter((id) => !reviewCorrelations.has(id));
  if (missingReviewCorrelations.length) {
    throw new Error(`复核审计缺少请求关联标识：${missingReviewCorrelations.join(", ")}`);
  }
  for (const event of events) {
    if (!event.actorDisplay || !event.occurredAt || !event.outcome || !event.action) throw new Error("审计事件字段不完整");
  }
  const serialized = JSON.stringify(events);
  for (const secret of SECRETS) {
    if (containsConfiguredSecret(serialized, secret)) throw new Error("审计事件包含敏感值");
  }
  return { events: events.length, failures: failures.length, actions: [...actions].length };
});

const ok = steps.every((item) => item.ok);
const modelStep = steps.find((item) => item.name === "real-model-parse");
const signoff = signoffEligibility({
  tlsVerified: TLS_VERIFY,
  dnsChecked: DNS_CHECKED,
  model: MODEL_ENDPOINT,
  ...state.signoff,
});
const accepted = ok && (!SIGNOFF || signoff.eligible);
console.log(JSON.stringify({
  ok: accepted,
  mode: MODE,
  runId: RUN_ID,
  host: HOST,
  port: PORT,
  origin: ORIGIN,
  tlsVerified: TLS_VERIFY,
  dnsChecked: DNS_CHECKED,
  realModel: REAL_MODEL,
  modelEndpoint: MODEL_ENDPOINT,
  modelEvidence: modelStep?.detail ?? null,
  signoff,
  cleanup: {
    disabledUsers: state.createdUserIds.length,
    removedModels: state.createdModelIds.length,
    removedProviders: state.createdProviderIds.length,
  },
  steps,
  backupName: state.backupName,
  auditEventCount: state.auditEvents.length,
}, null, 2));
process.exitCode = accepted ? 0 : 1;
