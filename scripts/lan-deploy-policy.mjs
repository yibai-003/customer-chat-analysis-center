import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractEntryAssets } from "../src/shared/entry-assets.js";

export { extractEntryAssets };

const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const DOCKER_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const REPOSITORY_COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const REGISTRY_COMPONENT = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const REGISTRY = `${REGISTRY_COMPONENT}(?:\\.${REGISTRY_COMPONENT})*(?::[0-9]+)?`;
const REPOSITORY_PATTERN = new RegExp(
  `^(?:(?:${REGISTRY})/)?${REPOSITORY_COMPONENT}(?:/${REPOSITORY_COMPONENT})*$`,
);
const SEMVER_WITH_BUILD_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)$/;
const VERSION_TAG_MAX_LENGTH = 115;

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isValidRepository(value) {
  return typeof value === "string"
    && value.length <= 255
    && REPOSITORY_PATTERN.test(value);
}

function isValidTaggedImageReference(value) {
  if (typeof value !== "string" || !value) return false;
  const lastSlash = value.lastIndexOf("/");
  const lastColon = value.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  if (!hasTag) return false;
  const repository = hasTag ? value.slice(0, lastColon) : value;
  const tag = hasTag ? value.slice(lastColon + 1) : undefined;
  return isValidRepository(repository)
    && DOCKER_TAG_PATTERN.test(tag);
}

function normalizeVersionTag(version) {
  if (typeof version !== "string" || !version) {
    throw new Error("version must be a non-empty Docker tag value");
  }
  let normalized = version;
  if (version.includes("+")) {
    if (!SEMVER_WITH_BUILD_PATTERN.test(version)) {
      throw new Error("version build metadata must use valid SemVer");
    }
    normalized = version.replace("+", "_");
  }
  if (
    normalized.length > VERSION_TAG_MAX_LENGTH
    || !DOCKER_TAG_PATTERN.test(normalized)
  ) {
    throw new Error("version must produce a valid Docker tag");
  }
  return normalized;
}

function assertAssetArray(value, field, extension) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`verification input ${field} must be a non-empty asset array`);
  }

  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`verification input ${field} must not be sparse`);
    }
    const assetPath = value[index];
    if (
      typeof assetPath !== "string"
      || assetPath.length === 0
      || assetPath.trim() !== assetPath
      || assetPath.startsWith("/")
      || assetPath.startsWith("./")
      || assetPath.includes("\\")
      || assetPath.includes("?")
      || assetPath.includes("#")
      || !assetPath.endsWith(extension)
      || assetPath.split("/").some((segment) => (
        segment.length === 0 || segment === "." || segment === ".."
      ))
    ) {
      throw new TypeError(
        `verification input ${field} must contain canonical ${extension} paths`,
      );
    }
    if (seen.has(assetPath)) {
      throw new TypeError(`verification input ${field} must contain unique paths`);
    }
    seen.add(assetPath);
  }
}

function assertVerificationInput(input) {
  if (!isPlainObject(input)) {
    throw new TypeError("verification input must be a plain object");
  }
  if (typeof input.healthy !== "boolean") {
    throw new TypeError("verification input healthy must be a boolean");
  }
  if (!Number.isInteger(input.readinessExitCode)) {
    throw new TypeError("verification input readinessExitCode must be an integer");
  }
  if (
    typeof input.targetCommitSha !== "string"
    || !SHA_PATTERN.test(input.targetCommitSha)
  ) {
    throw new TypeError("verification input targetCommitSha must be a full commit SHA");
  }
  if (!isValidTaggedImageReference(input.targetImage)) {
    throw new TypeError("verification input targetImage must be a tagged Docker image reference");
  }
  if (!isPlainObject(input.runtime)) {
    throw new TypeError("verification input runtime must be a plain object");
  }
  if (
    typeof input.runtime.commitSha !== "string"
    || !SHA_PATTERN.test(input.runtime.commitSha)
  ) {
    throw new TypeError("verification input runtime.commitSha must be a full commit SHA");
  }
  if (!isValidTaggedImageReference(input.runtime.image)) {
    throw new TypeError("verification input runtime.image must be a tagged Docker image reference");
  }
  if (!isPlainObject(input.runtime.assets)) {
    throw new TypeError("verification input runtime.assets must be a plain object");
  }
  if (!isPlainObject(input.entryAssets)) {
    throw new TypeError("verification input entryAssets must be a plain object");
  }
  assertAssetArray(input.runtime.assets.scripts, "runtime.assets.scripts", ".js");
  assertAssetArray(input.runtime.assets.styles, "runtime.assets.styles", ".css");
  assertAssetArray(input.entryAssets.scripts, "entryAssets.scripts", ".js");
  assertAssetArray(input.entryAssets.styles, "entryAssets.styles", ".css");
}

export function createImageTag(input) {
  if (!isPlainObject(input) || !isValidRepository(input.repository)) {
    throw new Error("repository must be a valid lowercase Docker repository");
  }
  const versionTag = normalizeVersionTag(input.version);
  if (typeof input.commitSha !== "string" || !SHA_PATTERN.test(input.commitSha)) {
    throw new Error("commit must be a full 40-character hexadecimal SHA");
  }
  return `${input.repository}:${versionTag}-${input.commitSha.slice(0, 12).toLowerCase()}`;
}

function sameAssets(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function verifyDeployment(input) {
  assertVerificationInput(input);
  const reasons = [];
  if (!input.healthy) reasons.push("health");
  if (input.readinessExitCode !== 0) reasons.push("readiness");
  if (
    input.runtime.commitSha.toLowerCase()
    !== input.targetCommitSha.toLowerCase()
  ) {
    reasons.push("commit");
  }
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
