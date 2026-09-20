import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractEntryAssets } from "../shared/entry-assets.js";
import { readRuntimeVersion } from "./runtime-version";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("runtime version", () => {
  it("returns injected build metadata and normalized entry assets", () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-version-"));
    roots.push(distDir);
    fs.writeFileSync(path.join(distDir, "index.html"), [
      '<script type="module" src="/assets/index-abc.js"></script>',
      '<link rel="stylesheet" href="/assets/index-def.css">',
    ].join(""));

    expect(readRuntimeVersion({
      distDir,
      env: {
        APP_VERSION: "0.1.0",
        APP_COMMIT_SHA: "a".repeat(40),
        APP_BUILD_TIME: "2026-09-20T08:00:00.000Z",
        APP_IMAGE: "customer-chat-analysis-center:0.1.0-aaaaaaaaaaaa",
      },
    })).toEqual({
      version: "0.1.0",
      commitSha: "a".repeat(40),
      buildTime: "2026-09-20T08:00:00.000Z",
      image: "customer-chat-analysis-center:0.1.0-aaaaaaaaaaaa",
      assets: {
        scripts: ["assets/index-abc.js"],
        styles: ["assets/index-def.css"],
      },
    });
  });

  it("uses explicit development defaults without reading Git metadata", () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-version-"));
    roots.push(distDir);
    expect(readRuntimeVersion({ distDir, env: {} })).toMatchObject({
      version: "0.1.0",
      commitSha: "development",
      buildTime: "development",
      image: "development",
      assets: { scripts: [], styles: [] },
    });
  });

  it("uses the shared HTML entry asset parser", () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-version-"));
    roots.push(distDir);
    const html = [
      '<!-- <script src="/assets/comment.js"></script> -->',
      '<script src="/assets/app.js?v=1" src="/assets/duplicate.js">',
      'const fake = "<link href=\\"/assets/script-string.css\\">";',
      "</script>",
      "<style>",
      '.fake { content: "<script src=\\"/assets/style-string.js\\">"; }',
      "</style>",
      '<link data-href="/assets/decoy.css" href="./assets/app.css#theme">',
    ].join("");
    fs.writeFileSync(path.join(distDir, "index.html"), html);

    const expected = extractEntryAssets(html);
    expect(expected).toEqual({
      scripts: ["assets/app.js"],
      styles: ["assets/app.css"],
    });
    expect(readRuntimeVersion({ distDir, env: {} }).assets).toEqual(expected);
  });
});
