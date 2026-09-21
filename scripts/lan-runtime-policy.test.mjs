import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("LAN runtime verification policy", () => {
  it("builds the verification image with traceable runtime metadata", () => {
    const script = fs.readFileSync(
      new URL("./verify-lan-runtime.ps1", import.meta.url),
      "utf8",
    );

    expect(script).toContain('node -p "require(\'./package.json\').version"');
    expect(script).toContain("rev-parse HEAD");
    expect(script).toContain('--build-arg "APP_VERSION=$packageVersion"');
    expect(script).toContain('--build-arg "APP_COMMIT_SHA=$commitSha"');
    expect(script).toContain('--build-arg "APP_BUILD_TIME=$buildTime"');
    expect(script).toContain('--build-arg "APP_IMAGE=$Image"');
    expect(script).toContain("$runtimeVersion.version -ne $packageVersion");
    expect(script).toContain("$runtimeVersion.commitSha -ne $commitSha");
    expect(script).toContain("$runtimeVersion.image -ne $Image");
  });
});
