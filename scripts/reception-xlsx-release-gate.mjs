import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const automatedOnly = args.has("--automated-only");
const evidenceArgument = process.argv.slice(2)
  .find((value) => value.startsWith("--manual-evidence="));
const evidencePath = evidenceArgument
  ? path.resolve(root, evidenceArgument.slice("--manual-evidence=".length))
  : process.env.RECEPTION_XLSX_MANUAL_EVIDENCE
    ? path.resolve(root, process.env.RECEPTION_XLSX_MANUAL_EVIDENCE)
    : "";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const artifactDir = path.resolve(
  root,
  process.env.RECEPTION_GATE_ARTIFACT_DIR
    ?? path.join("artifacts", "reception-xlsx", stamp),
);

fs.mkdirSync(artifactDir, { recursive: true });

function run(label, command, commandArgs) {
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env: {
      ...process.env,
      RECEPTION_GATE_ARTIFACT_DIR: artifactDir,
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

function loadManualEvidence(file, expectedExport) {
  if (!file || !fs.existsSync(file)) {
    throw new Error(
      "正式发布门禁缺少 Excel/WPS 人工证据；使用 --manual-evidence=<json> 提供",
    );
  }
  const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const application of ["excel", "wps"]) {
    const item = evidence[application];
    if (item?.opened !== true
      || typeof item.operator !== "string"
      || !item.operator.trim()
      || Number.isNaN(Date.parse(item.checkedAt))
      || typeof item.exportFile !== "string"
      || path.basename(item.exportFile) !== path.basename(expectedExport)
      || typeof item.notes !== "string"
      || !item.notes.trim()) {
      throw new Error(`${application} 人工证据不完整`);
    }
  }
  return evidence;
}

const checks = [];
try {
  checks.push(run(
    "reception XLSX end-to-end",
    npmCommand,
    ["run", "test:reception-xlsx"],
  ));
  checks.push(run("all automated tests", npmCommand, ["test"]));
  checks.push(run("typecheck", npmCommand, ["run", "typecheck"]));
  checks.push(run("production build", npmCommand, ["run", "build"]));

  const automatedReportPath = path.join(artifactDir, "automated-acceptance.json");
  if (!fs.existsSync(automatedReportPath)) {
    throw new Error("端到端测试未生成 automated-acceptance.json");
  }
  const automated = JSON.parse(fs.readFileSync(automatedReportPath, "utf8"));
  const expectedExport = automated.exports?.[0];
  if (typeof expectedExport !== "string" || !fs.existsSync(expectedExport)) {
    throw new Error("自动化验收记录缺少可验证的导出文件");
  }
  const manualEvidence = automatedOnly
    ? null
    : loadManualEvidence(evidencePath, expectedExport);
  const finalReport = {
    ...automated,
    qualityChecks: checks,
    manualEvidence,
    officialReleaseEligible: Boolean(manualEvidence),
    officialReleaseBlocker: manualEvidence
      ? null
      : "Excel/WPS 人工打开证据尚未附加；自动化验收通过，但不得进入正式发布",
  };
  fs.writeFileSync(
    path.join(artifactDir, "acceptance-record.json"),
    `${JSON.stringify(finalReport, null, 2)}\n`,
  );
  console.log(`Reception XLSX gate record: ${path.join(artifactDir, "acceptance-record.json")}`);
  if (!automatedOnly && !manualEvidence) process.exitCode = 1;
} catch (error) {
  const failure = {
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
