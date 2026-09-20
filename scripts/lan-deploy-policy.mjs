import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

function isValidImageReference(value) {
  if (typeof value !== "string" || !value) return false;
  const lastSlash = value.lastIndexOf("/");
  const lastColon = value.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const repository = hasTag ? value.slice(0, lastColon) : value;
  const tag = hasTag ? value.slice(lastColon + 1) : undefined;
  return isValidRepository(repository)
    && (tag === undefined || DOCKER_TAG_PATTERN.test(tag));
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

function assertStringArray(value, field) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`verification input ${field} must be a string array`);
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
  if (!isValidImageReference(input.targetImage)) {
    throw new TypeError("verification input targetImage must be a Docker image reference");
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
  if (!isValidImageReference(input.runtime.image)) {
    throw new TypeError("verification input runtime.image must be a Docker image reference");
  }
  if (!isPlainObject(input.runtime.assets)) {
    throw new TypeError("verification input runtime.assets must be a plain object");
  }
  if (!isPlainObject(input.entryAssets)) {
    throw new TypeError("verification input entryAssets must be a plain object");
  }
  assertStringArray(input.runtime.assets.scripts, "runtime.assets.scripts");
  assertStringArray(input.runtime.assets.styles, "runtime.assets.styles");
  assertStringArray(input.entryAssets.scripts, "entryAssets.scripts");
  assertStringArray(input.entryAssets.styles, "entryAssets.styles");
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

function findTagEnd(source, start) {
  let quote;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return source.length;
}

function quotedAttributeValues(source, start, end, targetName) {
  const values = [];
  let index = start;
  while (index < end) {
    while (index < end && /\s|\//.test(source[index])) index += 1;
    const nameStart = index;
    while (index < end && !/[\s=/>]/.test(source[index])) index += 1;
    if (nameStart === index) {
      index += 1;
      continue;
    }
    const name = source.slice(nameStart, index).toLowerCase();
    while (index < end && /\s/.test(source[index])) index += 1;
    if (source[index] !== "=") continue;
    index += 1;
    while (index < end && /\s/.test(source[index])) index += 1;
    const quote = source[index];
    if (quote !== '"' && quote !== "'") {
      while (index < end && !/[\s>]/.test(source[index])) index += 1;
      continue;
    }
    index += 1;
    const valueStart = index;
    while (index < end && source[index] !== quote) index += 1;
    const value = source.slice(valueStart, index);
    if (index < end) index += 1;
    if (name === targetName) values.push(value);
  }
  return values;
}

function normalizeAssetPath(value, extension) {
  const trimmed = value.trim();
  const suffixIndex = trimmed.search(/[?#]/);
  const pathValue = (suffixIndex === -1 ? trimmed : trimmed.slice(0, suffixIndex))
    .replace(/^\/+/, "");
  return pathValue.toLowerCase().endsWith(extension) ? pathValue : undefined;
}

export function extractEntryAssets(html) {
  const source = String(html);
  const assets = { scripts: [], styles: [] };
  const seen = { scripts: new Set(), styles: new Set() };
  let cursor = 0;

  while (cursor < source.length) {
    const opening = source.indexOf("<", cursor);
    if (opening === -1) break;
    let index = opening + 1;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (source[index] === "/" || source[index] === "!" || source[index] === "?") {
      cursor = opening + 1;
      continue;
    }

    const nameStart = index;
    while (index < source.length && /[A-Za-z0-9:-]/.test(source[index])) index += 1;
    const tagName = source.slice(nameStart, index).toLowerCase();
    const tagEnd = findTagEnd(source, index);
    cursor = tagEnd + 1;

    const definition = tagName === "script"
      ? { attribute: "src", extension: ".js", collection: "scripts" }
      : tagName === "link"
        ? { attribute: "href", extension: ".css", collection: "styles" }
        : undefined;
    if (!definition) continue;

    for (const value of quotedAttributeValues(
      source,
      index,
      tagEnd,
      definition.attribute,
    )) {
      const assetPath = normalizeAssetPath(value, definition.extension);
      if (assetPath && !seen[definition.collection].has(assetPath)) {
        seen[definition.collection].add(assetPath);
        assets[definition.collection].push(assetPath);
      }
    }
  }

  return assets;
}

function sameAssets(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function verifyDeployment(input) {
  assertVerificationInput(input);
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
