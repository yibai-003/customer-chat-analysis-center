import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createImageTag,
  extractEntryAssets,
  verifyDeployment,
} from "./lan-deploy-policy.mjs";

const policyPath = fileURLToPath(new URL("./lan-deploy-policy.mjs", import.meta.url));

function runCli(args, input) {
  return spawnSync(process.execPath, [policyPath, ...args], {
    encoding: "utf8",
    input,
  });
}

function matchingDeployment() {
  return {
    targetCommitSha: "a".repeat(40),
    targetImage: "app:0.1.0-aaaaaaaaaaaa",
    healthy: true,
    readinessExitCode: 0,
    runtime: {
      commitSha: "a".repeat(40),
      image: "app:0.1.0-aaaaaaaaaaaa",
      assets: {
        scripts: ["assets/vendor.js", "assets/app.js"],
        styles: ["assets/theme.css", "assets/app.css"],
      },
    },
    entryAssets: {
      scripts: ["assets/app.js", "assets/vendor.js"],
      styles: ["assets/app.css", "assets/theme.css"],
    },
  };
}

describe("LAN deployment policy", () => {
  it("binds the package version to a lowercase twelve-character commit prefix", () => {
    expect(createImageTag({
      repository: "customer-chat-analysis-center",
      version: "0.1.0",
      commitSha: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
    })).toBe("customer-chat-analysis-center:0.1.0-abcdef123456");
  });

  it.each([
    { repository: "app", version: "0.1.0", commitSha: "dirty" },
    { repository: "app", version: "0.1.0", commitSha: "a".repeat(39) },
    { repository: "app", version: "0.1.0", commitSha: "a".repeat(41) },
    { repository: "app", version: "0.1.0", commitSha: `${"a".repeat(39)}g` },
    { repository: "", version: "0.1.0", commitSha: "a".repeat(40) },
    { repository: "app", version: "", commitSha: "a".repeat(40) },
  ])("rejects incomplete image tag input: $commitSha", (input) => {
    expect(() => createImageTag(input)).toThrow(/repository.*version.*commit/i);
  });

  it("extracts normalized unique JavaScript and stylesheet entry paths", () => {
    const html = [
      '<script type="module" src="/assets/index-a.js"></script>',
      '<script src="assets/index-a.js"></script>',
      "<script src='/assets/vendor-b.js'></script>",
      '<link href="/assets/index-c.css" rel="stylesheet">',
      '<link rel="stylesheet" href="assets/index-c.css">',
      "<link href='/assets/theme-d.css' rel='stylesheet'>",
    ].join("");

    expect(extractEntryAssets(html)).toEqual({
      scripts: ["assets/index-a.js", "assets/vendor-b.js"],
      styles: ["assets/index-c.css", "assets/theme-d.css"],
    });
  });

  it("accepts a healthy ready deployment with matching order-insensitive assets", () => {
    expect(verifyDeployment(matchingDeployment())).toEqual({
      ok: true,
      reasons: [],
      rollback: false,
    });
  });

  it("reports every mismatch independently in deterministic policy order", () => {
    const input = matchingDeployment();
    input.healthy = false;
    input.readinessExitCode = 1;
    input.runtime.commitSha = "b".repeat(40);
    input.runtime.image = "app:0.1.0-bbbbbbbbbbbb";
    input.entryAssets.scripts = ["assets/old.js"];

    expect(verifyDeployment(input)).toEqual({
      ok: false,
      reasons: ["health", "readiness", "commit", "image", "assets"],
      rollback: true,
    });
  });

  it("compares scripts and styles as separate asset sets", () => {
    const input = matchingDeployment();
    input.entryAssets = {
      scripts: input.runtime.assets.styles,
      styles: input.runtime.assets.scripts,
    };

    expect(verifyDeployment(input)).toEqual({
      ok: false,
      reasons: ["assets"],
      rollback: true,
    });
  });

  it("prints an image tag and exits zero for a valid image-tag command", () => {
    const result = runCli([
      "image-tag",
      "customer-chat-analysis-center",
      "0.1.0",
      "a".repeat(40),
    ]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "customer-chat-analysis-center:0.1.0-aaaaaaaaaaaa",
    );
  });

  it("returns zero for a passing verification and one for a policy failure", () => {
    const passing = runCli(["verify"], JSON.stringify(matchingDeployment()));
    const failingInput = matchingDeployment();
    failingInput.healthy = false;
    const failing = runCli(["verify"], JSON.stringify(failingInput));

    expect(passing.status).toBe(0);
    expect(JSON.parse(passing.stdout)).toEqual({
      ok: true,
      reasons: [],
      rollback: false,
    });
    expect(failing.status).toBe(1);
    expect(JSON.parse(failing.stdout)).toEqual({
      ok: false,
      reasons: ["health"],
      rollback: true,
    });
  });

  it.each([
    { args: ["image-tag", "app", "0.1.0"], input: undefined },
    { args: ["image-tag", "app", "0.1.0", "dirty"], input: undefined },
    { args: ["verify"], input: "not-json" },
    { args: ["verify", "unexpected"], input: "{}" },
    { args: ["unsupported"], input: undefined },
  ])("returns two for invalid CLI input: $args", ({ args, input }) => {
    const result = runCli(args, input);

    expect(result.status).toBe(2);
    expect(result.stderr.trim()).not.toBe("");
  });
});
