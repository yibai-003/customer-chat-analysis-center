import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const automatedOnly = args.has("--automated-only");
const argumentValue = (name) => process.argv.slice(2)
  .find((value) => value.startsWith(`--${name}=`))
  ?.slice(name.length + 3);
const evidenceArgument = argumentValue("manual-evidence");
const evidencePath = evidenceArgument
  ? path.resolve(root, evidenceArgument)
  : process.env.RECEPTION_XLSX_MANUAL_EVIDENCE
    ? path.resolve(root, process.env.RECEPTION_XLSX_MANUAL_EVIDENCE)
    : "";
const artifactArgument = argumentValue("artifact-dir");
const realSampleArgument = argumentValue("real-sample");
const realSamplePath = realSampleArgument
  ? path.resolve(root, realSampleArgument)
  : process.env.RECEPTION_XLSX_REAL_SAMPLE
    ? path.resolve(root, process.env.RECEPTION_XLSX_REAL_SAMPLE)
    : "";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)
  ? process.env.npm_execpath
  : "";
const artifactDir = path.resolve(
  root,
  artifactArgument
    ?? process.env.RECEPTION_GATE_ARTIFACT_DIR
    ?? path.join("artifacts", "reception-xlsx", stamp),
);

fs.mkdirSync(artifactDir, { recursive: true });

function fileSha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function run(label, command, commandArgs) {
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env: {
      ...process.env,
      RECEPTION_GATE_ARTIFACT_DIR: artifactDir,
      ...(realSamplePath ? { RECEPTION_XLSX_REAL_SAMPLE: realSamplePath } : {}),
    },
    encoding: "utf8",
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
  return { label, status: "passed", durationMs: Date.now() - started };
}

function runNpm(label, commandArgs) {
  return npmCli
    ? run(label, process.execPath, [npmCli, ...commandArgs])
    : run(label, npmCommand, commandArgs);
}

function evidenceFileMatches(item, expectedFile, field) {
  return typeof item[field] === "string"
    && path.basename(item[field]) === path.basename(expectedFile)
    && typeof item[`${field}Sha256`] === "string"
    && item[`${field}Sha256`].toLowerCase() === fileSha256(expectedFile);
}

function validCheckedAt(value, candidateGeneratedAt) {
  const checkedAt = Date.parse(value);
  const generatedAt = Date.parse(candidateGeneratedAt);
  return !Number.isNaN(checkedAt)
    && !Number.isNaN(generatedAt)
    && checkedAt >= generatedAt;
}

function loadManualEvidence(file, expectedExport, expectedSample, candidateGeneratedAt) {
  if (!file || !fs.existsSync(file)) {
    throw new Error(
      "正式发布门禁缺少 Excel/WPS 人工证据；使用 --manual-evidence=<json> 提供",
    );
  }
  const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
  const sample = evidence.sample;
  if (sample?.anonymizedReal !== true
    || sample?.wpsProduced !== true
    || typeof sample.operator !== "string"
    || !sample.operator.trim()
    || !validCheckedAt(sample.checkedAt, candidateGeneratedAt)
    || !evidenceFileMatches(sample, expectedSample, "sampleFile")
    || typeof sample.notes !== "string"
    || !sample.notes.trim()) {
    throw new Error("真实脱敏 WPS 样本证据不完整或与候选样本不一致");
  }
  for (const application of ["excel", "wps"]) {
    const item = evidence[application];
    if (item?.opened !== true
      || typeof item.operator !== "string"
      || !item.operator.trim()
      || !validCheckedAt(item.checkedAt, candidateGeneratedAt)
      || !evidenceFileMatches(item, expectedExport, "exportFile")
      || typeof item.notes !== "string"
      || !item.notes.trim()) {
      throw new Error(`${application} 人工证据不完整`);
    }
  }
  return evidence;
}

const checks = [];
let baseReport = {};
try {
  let automated;
  if (automatedOnly) {
    checks.push(runNpm(
      "reception XLSX end-to-end",
      ["run", "test:reception-xlsx"],
    ));
    checks.push(runNpm("all automated tests", ["test"]));
    checks.push(runNpm("typecheck", ["run", "typecheck"]));
    checks.push(runNpm("production build", ["run", "build"]));
    const automatedReportPath = path.join(artifactDir, "automated-acceptance.json");
    if (!fs.existsSync(automatedReportPath)) {
      throw new Error("端到端测试未生成 automated-acceptance.json");
    }
    automated = JSON.parse(fs.readFileSync(automatedReportPath, "utf8"));
  } else {
    if (!artifactArgument && !process.env.RECEPTION_GATE_ARTIFACT_DIR) {
      throw new Error("正式发布门禁必须使用 --artifact-dir=<候选工件目录>，确保人工验收与自动化验证针对同一文件");
    }
    const candidateRecordPath = path.join(artifactDir, "acceptance-record.json");
    if (!fs.existsSync(candidateRecordPath)) {
      throw new Error("候选工件目录缺少 acceptance-record.json，请先运行自动化门禁");
    }
    const candidate = JSON.parse(fs.readFileSync(candidateRecordPath, "utf8"));
    if (!Array.isArray(candidate.qualityChecks)
      || !candidate.qualityChecks.length
      || candidate.qualityChecks.some((check) => check.status !== "passed")) {
      throw new Error("候选工件没有完整通过自动化测试、类型检查和生产构建");
    }
    automated = candidate;
    checks.push(...candidate.qualityChecks);
  }
  baseReport = automated;

  const expectedExport = automated.exports?.[0];
  if (typeof expectedExport !== "string" || !fs.existsSync(expectedExport)) {
    throw new Error("自动化验收记录缺少可验证的导出文件");
  }
  const recordedExport = automated.exportArtifacts?.find((item) => item.path === expectedExport);
  if (!recordedExport || recordedExport.sha256 !== fileSha256(expectedExport)) {
    throw new Error("导出文件与自动化验收记录中的 SHA-256 不一致");
  }
  const expectedSample = automated.sample?.artifactPath;
  if (typeof expectedSample !== "string" || !fs.existsSync(expectedSample)) {
    throw new Error("自动化验收记录缺少可验证的样本文件");
  }
  if (automated.sample.sha256 !== fileSha256(expectedSample)) {
    throw new Error("样本文件与自动化验收记录中的 SHA-256 不一致");
  }
  if (!automatedOnly && automated.sample.provenance !== "external-real") {
    throw new Error("正式发布门禁必须使用 --real-sample 指定的外部脱敏真实样本，合成样本只能用于自动化回归");
  }
  const manualEvidence = automatedOnly
    ? null
    : loadManualEvidence(evidencePath, expectedExport, expectedSample, automated.generatedAt);
  const finalReport = {
    ...automated,
    qualityChecks: checks,
    manualEvidence,
    officialReleaseEligible: Boolean(manualEvidence),
    officialReleaseBlocker: manualEvidence
      ? null
      : "外部脱敏真实/WPS 样本及 Excel/WPS 人工打开证据尚未附加；自动化验收通过，但不得进入正式发布",
  };
  fs.writeFileSync(
    path.join(artifactDir, "acceptance-record.json"),
    `${JSON.stringify(finalReport, null, 2)}\n`,
  );
  console.log(`Reception XLSX gate record: ${path.join(artifactDir, "acceptance-record.json")}`);
  if (!automatedOnly && !manualEvidence) process.exitCode = 1;
} catch (error) {
  const failure = {
    ...baseReport,
    ticket: 7,
    generatedAt: new Date().toISOString(),
    officialReleaseEligible: false,
    failedCheck: error instanceof Error ? error.message : String(error),
    qualityChecks: checks,
  };
  fs.writeFileSync(
    path.join(artifactDir, "acceptance-record.json"),
    `${JSON.stringify(failure, null, 2)}\n`,
  );
  console.error(failure.failedCheck);
  process.exitCode = 1;
}
