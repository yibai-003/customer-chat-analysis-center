import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("CI release artifact policy", () => {
  it("publishes an importable image with traceable build metadata", () => {
    const workflow = fs.readFileSync(
      new URL("../.github/workflows/quality-gates.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain('--build-arg "APP_VERSION=$VERSION"');
    expect(workflow).toContain('--build-arg "APP_COMMIT_SHA=$GITHUB_SHA"');
    expect(workflow).toContain('--build-arg "APP_BUILD_TIME=');
    expect(workflow).toContain('--build-arg "APP_IMAGE=$IMAGE"');
    expect(workflow).toContain('docker save "$IMAGE_TAG"');
    expect(workflow).toContain("gzip");
    expect(workflow).toContain("imageArchive");
    expect(workflow).toContain("dockerLoad");
  });
});
