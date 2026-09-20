import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createImageTag,
  extractEntryAssets,
  verifyDeployment,
} from "./lan-deploy-policy.mjs";

const policyPath = fileURLToPath(new URL("./lan-deploy-policy.mjs", import.meta.url));
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

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

const malformedVerificationCases = [
  ["null input", () => null],
  ["array input", () => []],
  ["missing target and runtime", () => ({
    healthy: true,
    readinessExitCode: 0,
  })],
  ["string healthy value", () => ({
    ...matchingDeployment(),
    healthy: "false",
  })],
  ["non-integer readiness exit code", () => ({
    ...matchingDeployment(),
    readinessExitCode: 0.5,
  })],
  ["missing target commit", () => {
    const input = matchingDeployment();
    delete input.targetCommitSha;
    return input;
  }],
  ["short target commit", () => ({
    ...matchingDeployment(),
    targetCommitSha: "a".repeat(12),
  })],
  ["short runtime commit", () => {
    const input = matchingDeployment();
    input.runtime.commitSha = "a".repeat(12);
    return input;
  }],
  ["invalid target image", () => ({
    ...matchingDeployment(),
    targetImage: "bad image",
  })],
  ["invalid runtime image", () => {
    const input = matchingDeployment();
    input.runtime.image = "bad image";
    return input;
  }],
  ["missing runtime assets", () => {
    const input = matchingDeployment();
    delete input.runtime.assets;
    return input;
  }],
  ["missing runtime", () => {
    const input = matchingDeployment();
    delete input.runtime;
    return input;
  }],
  ["missing entry assets", () => {
    const input = matchingDeployment();
    delete input.entryAssets;
    return input;
  }],
  ["string runtime scripts", () => {
    const input = matchingDeployment();
    input.runtime.assets.scripts = "assets/app.js";
    return input;
  }],
  ["string runtime styles", () => {
    const input = matchingDeployment();
    input.runtime.assets.styles = "assets/app.css";
    return input;
  }],
  ["string entry scripts", () => {
    const input = matchingDeployment();
    input.entryAssets.scripts = "assets/app.js";
    return input;
  }],
  ["non-string entry style", () => {
    const input = matchingDeployment();
    input.entryAssets.styles = [42];
    return input;
  }],
  ["empty asset sets", () => {
    const input = matchingDeployment();
    input.runtime.assets = { scripts: [], styles: [] };
    input.entryAssets = { scripts: [], styles: [] };
    return input;
  }],
  ["empty asset path", () => {
    const input = matchingDeployment();
    input.runtime.assets.scripts = [""];
    return input;
  }],
  ["script path with query", () => {
    const input = matchingDeployment();
    input.runtime.assets.scripts = ["assets/app.js?v=1"];
    return input;
  }],
  ["style path with hash", () => {
    const input = matchingDeployment();
    input.entryAssets.styles = ["assets/app.css#theme"];
    return input;
  }],
  ["script path with leading slash", () => {
    const input = matchingDeployment();
    input.entryAssets.scripts = ["/assets/app.js"];
    return input;
  }],
  ["style path with dot slash", () => {
    const input = matchingDeployment();
    input.runtime.assets.styles = ["./assets/app.css"];
    return input;
  }],
  ["script path with wrong extension", () => {
    const input = matchingDeployment();
    input.runtime.assets.scripts = ["assets/app.css"];
    return input;
  }],
  ["style path with wrong extension", () => {
    const input = matchingDeployment();
    input.entryAssets.styles = ["assets/app.js"];
    return input;
  }],
  ["duplicate asset path", () => {
    const input = matchingDeployment();
    input.runtime.assets.scripts = ["assets/app.js", "assets/app.js"];
    return input;
  }],
  ["asset path with internal space", () => {
    const input = matchingDeployment();
    input.runtime.assets.scripts = ["assets/a b.js"];
    return input;
  }],
  ["asset path with control character", () => {
    const input = matchingDeployment();
    input.entryAssets.styles = ["assets/a\n.css"];
    return input;
  }],
  ["sparse asset array", () => {
    const input = matchingDeployment();
    input.entryAssets.styles = new Array(1);
    return input;
  }],
  ["untagged target image", () => ({
    ...matchingDeployment(),
    targetImage: "registry.example.com:5000/org/app",
  })],
  ["untagged runtime image", () => {
    const input = matchingDeployment();
    input.runtime.image = "org/app";
    return input;
  }],
];

const invalidImageTagCases = [
  ["uppercase repository", "Org/app", "0.1.0"],
  ["repository with spaces", "bad repo", "0.1.0"],
  ["repository containing a tag", "bad:tag", "0.1.0"],
  ["repository starting with a dot", ".bad", "0.1.0"],
  ["repository starting with a dash", "-bad", "0.1.0"],
  ["repository ending with a dot", "bad.", "0.1.0"],
  ["repository ending with a dash", "bad-", "0.1.0"],
  ["overlong repository", "a".repeat(256), "0.1.0"],
  ["version with spaces", "app", "bad version"],
  ["version containing a tag colon", "app", "bad:tag"],
  ["version starting with a dot", "app", ".bad"],
  ["version starting with a dash", "app", "-bad"],
  ["invalid build metadata", "app", "v1.2.3+build"],
  ["overlong version", "app", "v".repeat(116)],
];

describe("LAN deployment policy", () => {
  it("wires Docker metadata and the deployment entry point", () => {
    const dockerfile = fs.readFileSync(`${projectRoot}/Dockerfile`, "utf8");
    const compose = fs.readFileSync(`${projectRoot}/deploy/docker-compose.yml`, "utf8");
    const script = fs.readFileSync(`${projectRoot}/scripts/lan-deploy.ps1`, "utf8");

    expect(dockerfile).toContain("ARG APP_VERSION");
    expect(dockerfile).toContain("ARG APP_COMMIT_SHA");
    expect(dockerfile).toContain("ARG APP_BUILD_TIME");
    expect(dockerfile).toContain("ARG APP_IMAGE");
    expect(dockerfile).toContain("ENV APP_COMMIT_SHA=");
    expect(compose).toContain("APP_CONTAINER_NAME");
    for (const name of [
      "APP_VERSION",
      "APP_COMMIT_SHA",
      "APP_BUILD_TIME",
      "APP_IMAGE",
    ]) {
      expect(compose).toContain(`${name}:`);
      expect(compose).toContain(`${name}:-`);
    }
    expect(script).toContain("npm run ready:check");
    expect(script).toContain("lan-deploy-policy.mjs");
    expect(script).toContain("RollbackImage");
    expect(script).toContain("npm run check:installation");
    expect(script).toContain("npm run typecheck");
    expect(script).toContain("npm run lint");
    expect(script).toContain("npm run build");
    expect(script).toContain("--build-arg \"APP_COMMIT_SHA=$commit\"");
    expect(script).toContain("docker compose");
  });

  it("checks the restored runtime image without deleting persistent directories", () => {
    const script = fs.readFileSync(`${projectRoot}/scripts/lan-deploy.ps1`, "utf8");

    expect(script).toContain("$restoredRuntime = Get-RuntimeVersion");
    expect(script).toContain("$restoredRuntime.image -ne $previousImage");
    expect(script).not.toMatch(
      /Remove-Item[^\r\n]*(DEPLOY_DATA_DIR|DEPLOY_KNOWLEDGE_DIR)/i,
    );
  });

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
    expect(() => createImageTag(input)).toThrow(/repository|version|commit/i);
  });

  it.each([
    "customer-chat-analysis-center",
    "org/customer-chat-analysis-center",
    "registry.example.com:5000/org/customer-chat-analysis-center",
  ])("supports a valid Docker repository: %s", (repository) => {
    expect(createImageTag({
      repository,
      version: "0.1.0",
      commitSha: "a".repeat(40),
    })).toBe(`${repository}:0.1.0-aaaaaaaaaaaa`);
  });

  it("normalizes SemVer build metadata into a Docker-safe tag", () => {
    expect(createImageTag({
      repository: "app",
      version: "1.2.3-rc.1+build.5",
      commitSha: "a".repeat(40),
    })).toBe("app:1.2.3-rc.1_build.5-aaaaaaaaaaaa");
  });

  it("reserves the commit suffix inside the Docker tag length limit", () => {
    const version = "v".repeat(115);
    const tag = createImageTag({
      repository: "app",
      version,
      commitSha: "a".repeat(40),
    });

    expect(tag).toBe(`app:${version}-aaaaaaaaaaaa`);
    expect(tag.slice("app:".length)).toHaveLength(128);
  });

  it.each(invalidImageTagCases)(
    "rejects unsafe image tag input: %s",
    (_label, repository, version) => {
      const input = { repository, version, commitSha: "a".repeat(40) };

      expect(() => createImageTag(input)).toThrow(/repository|version/i);

      const result = runCli(["image-tag", repository, version, input.commitSha]);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/repository|version/i);
    },
  );

  it.each([
    "Org/app:0.1.0",
    "app:bad tag",
    "bad:tag:extra",
    ".bad:0.1.0",
    `${"a".repeat(256)}:0.1.0`,
  ])("rejects an unsafe verification image reference: %s", (image) => {
    const input = matchingDeployment();
    input.targetImage = image;
    input.runtime.image = image;

    expect(() => verifyDeployment(input)).toThrow(/verification input.*image/i);

    const result = runCli(["verify"], JSON.stringify(input));
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/verification input.*image/i);
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

  it("parses exact entry attributes and removes URL query and hash suffixes", () => {
    const html = [
      '<script data-src="/assets/decoy.js"></script>',
      '<script xsrc="/assets/also-decoy.js"></script>',
      '<SCRIPT SRC = "/assets/index-a.js?v=1#entry"></SCRIPT>',
      "<script src = '/assets/index-a.js?duplicate=1'></script>",
      "<script Src='/assets/vendor-b.js#module'></script>",
      '<link data-href="/assets/decoy.css" rel="stylesheet">',
      '<link xhref="/assets/also-decoy.css" rel="stylesheet">',
      "<LINK HREF = '/assets/index-c.css?v=2#theme' REL='stylesheet'>",
      '<link rel="stylesheet" Href="/assets/theme-d.css#dark">',
    ].join("");

    expect(extractEntryAssets(html)).toEqual({
      scripts: ["assets/index-a.js", "assets/vendor-b.js"],
      styles: ["assets/index-c.css", "assets/theme-d.css"],
    });
  });

  it("follows HTML boundaries and raw-text rules for entry assets", () => {
    const html = [
      '<!-- <script src="/assets/comment.js"></script> -->',
      '<!DOCTYPE html PUBLIC "<script src=\'/assets/declaration.js\'>">',
      '<?instruction href="/assets/instruction.css"?>',
      '< script src="/assets/spaced-tag.js"></script>',
      '<scripture src="/assets/not-script.js"></scripture>',
      '<script src="/assets/app.js?v=1#entry" src="/assets/duplicate.js">',
      'const fake = "<script src=\\"/assets/script-string.js\\"></script>";',
      "</script>",
      "<style>",
      '.fake::before { content: "<link href=\\"/assets/style-string.css\\">"; }',
      "</style>",
      '<link data-href="/assets/decoy.css" HREF = "./assets/app.css?theme=1#main" href="/assets/duplicate.css">',
      '<script SRC="./assets/vendor.js#module"></script>',
      '<link href="/assets/app.css?duplicate=1">',
    ].join("");

    expect(extractEntryAssets(html)).toEqual({
      scripts: ["assets/app.js", "assets/vendor.js"],
      styles: ["assets/app.css"],
    });
  });

  it("accepts a healthy ready deployment with matching order-insensitive assets", () => {
    expect(verifyDeployment(matchingDeployment())).toEqual({
      ok: true,
      reasons: [],
      rollback: false,
    });
  });

  it("compares valid commit SHAs case-insensitively", () => {
    const input = matchingDeployment();
    input.targetCommitSha = "ABCDEF1234567890ABCDEF1234567890ABCDEF12";
    input.runtime.commitSha = "abcdef1234567890abcdef1234567890abcdef12";
    input.targetImage = "app:0.1.0-abcdef123456";
    input.runtime.image = "app:0.1.0-abcdef123456";

    expect(verifyDeployment(input)).toEqual({
      ok: true,
      reasons: [],
      rollback: false,
    });
  });

  it("requires image tags to end with the target commit prefix", () => {
    const input = matchingDeployment();
    input.targetImage = "app:0.1.0-bbbbbbbbbbbb";
    input.runtime.image = "app:0.1.0-bbbbbbbbbbbb";

    expect(verifyDeployment(input)).toEqual({
      ok: false,
      reasons: ["image"],
      rollback: true,
    });

    const result = runCli(["verify"], JSON.stringify(input));
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      reasons: ["image"],
      rollback: true,
    });
  });

  it("accepts a correctly bound image tag with normalized SHA case", () => {
    const input = matchingDeployment();
    input.targetCommitSha = "ABCDEF1234567890ABCDEF1234567890ABCDEF12";
    input.runtime.commitSha = "abcdef1234567890abcdef1234567890abcdef12";
    input.targetImage = "app:0.1.0-abcdef123456";
    input.runtime.image = "app:0.1.0-abcdef123456";

    expect(verifyDeployment(input)).toEqual({
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

  it("rejects assets assigned to the wrong collection", () => {
    const input = matchingDeployment();
    input.entryAssets = {
      scripts: input.runtime.assets.styles,
      styles: input.runtime.assets.scripts,
    };

    expect(() => verifyDeployment(input)).toThrow(/verification input.*scripts/i);
  });

  it.each(malformedVerificationCases)(
    "rejects malformed verification input: %s",
    (_label, createInput) => {
      const input = createInput();

      expect(() => verifyDeployment(input)).toThrow(/verification input/i);

      const result = runCli(["verify"], JSON.stringify(input));
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/verification input/i);
    },
  );

  it("rejects non-plain verification objects", () => {
    class VerificationInput {}
    const input = Object.assign(new VerificationInput(), matchingDeployment());

    expect(() => verifyDeployment(input)).toThrow(/verification input/i);
  });

  it("rejects boxed commit strings instead of coercing them", () => {
    const targetInput = matchingDeployment();
    targetInput.targetCommitSha = new String("a".repeat(40));
    const runtimeInput = matchingDeployment();
    runtimeInput.runtime.commitSha = new String("a".repeat(40));

    expect(() => verifyDeployment(targetInput)).toThrow(
      /verification input.*targetCommitSha/i,
    );
    expect(() => verifyDeployment(runtimeInput)).toThrow(
      /verification input.*runtime\.commitSha/i,
    );
  });

  it("reports image mismatch for two different valid image references", () => {
    const input = matchingDeployment();
    input.targetImage = "registry.example.com:5000/org/app:release-a";
    input.runtime.image = "registry.example.com:5000/org/app:release-b";

    expect(verifyDeployment(input)).toEqual({
      ok: false,
      reasons: ["image"],
      rollback: true,
    });

    const result = runCli(["verify"], JSON.stringify(input));
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      reasons: ["image"],
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

  it("executes the CLI when Node receives a relative script path", () => {
    const result = spawnSync(process.execPath, [
      "scripts/lan-deploy-policy.mjs",
      "image-tag",
      "app",
      "0.1.0",
      "a".repeat(40),
    ], {
      cwd: projectRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("app:0.1.0-aaaaaaaaaaaa");
    expect(result.stderr).toBe("");
  });

  it("does not execute the CLI when the policy module is imported", () => {
    const moduleUrl = pathToFileURL(policyPath).href;
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(moduleUrl)}); process.stdout.write("imported\\n");`,
    ], {
      encoding: "utf8",
      input: JSON.stringify(matchingDeployment()),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("imported\n");
    expect(result.stderr).toBe("");
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
