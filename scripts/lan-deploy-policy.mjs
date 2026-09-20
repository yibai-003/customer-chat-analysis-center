import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^[a-f0-9]{40}$/i;

export function createImageTag({ repository, version, commitSha }) {
  const normalizedRepository = repository?.trim();
  const normalizedVersion = version?.trim();
  if (
    !normalizedRepository
    || !normalizedVersion
    || !SHA_PATTERN.test(commitSha)
  ) {
    throw new Error("repository, version and full commit SHA are required");
  }
  return `${normalizedRepository}:${normalizedVersion}-${commitSha.slice(0, 12).toLowerCase()}`;
}

export function extractEntryAssets(html) {
  const source = String(html);
  const scripts = [...source.matchAll(/<script[^>]+src=["']\/?([^"']+\.js)["']/gi)]
    .map((match) => match[1]);
  const styles = [...source.matchAll(/<link[^>]+href=["']\/?([^"']+\.css)["']/gi)]
    .map((match) => match[1]);
  return {
    scripts: [...new Set(scripts)],
    styles: [...new Set(styles)],
  };
}

function sameAssets(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function verifyDeployment(input) {
  const reasons = [];
  if (!input.healthy) reasons.push("health");
  if (input.readinessExitCode !== 0) reasons.push("readiness");
  if (input.runtime?.commitSha !== input.targetCommitSha) reasons.push("commit");
  if (input.runtime?.image !== input.targetImage) reasons.push("image");
  if (
    !sameAssets(input.runtime?.assets?.scripts ?? [], input.entryAssets?.scripts ?? [])
    || !sameAssets(input.runtime?.assets?.styles ?? [], input.entryAssets?.styles ?? [])
  ) {
    reasons.push("assets");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    rollback: reasons.length > 0,
  };
}

function writeLine(stream, value) {
  stream.write(`${value}\n`);
}

function runCli(args) {
  try {
    const [command, ...commandArgs] = args;
    if (command === "image-tag") {
      if (commandArgs.length !== 3) {
        throw new Error("usage: image-tag <repository> <version> <full-sha>");
      }
      writeLine(process.stdout, createImageTag({
        repository: commandArgs[0],
        version: commandArgs[1],
        commitSha: commandArgs[2],
      }));
      return 0;
    }

    if (command === "verify") {
      if (commandArgs.length !== 0) {
        throw new Error("usage: verify");
      }
      const input = JSON.parse(fs.readFileSync(0, "utf8"));
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("verification input must be a JSON object");
      }
      const result = verifyDeployment(input);
      writeLine(process.stdout, JSON.stringify(result));
      return result.ok ? 0 : 1;
    }

    throw new Error(`unsupported command: ${command ?? ""}`);
  } catch (error) {
    writeLine(
      process.stderr,
      error instanceof Error ? error.message : String(error),
    );
    return 2;
  }
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  process.exitCode = runCli(process.argv.slice(2));
}
