// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const clientRoot = resolve(process.cwd(), "src/client");
const nativeSelectPattern = /(^|[\s>+~,:])select(?=[:\s>,+~[\])]|$)/;

function productionTsxFiles(directory = clientRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return productionTsxFiles(path);
    if (!entry.name.endsWith(".tsx") || entry.name.endsWith(".test.tsx")) return [];
    return [path];
  });
}

describe("select menu migration contract", () => {
  it("uses the shared select menu instead of native select popups", () => {
    const remaining = productionTsxFiles().filter((path) =>
      /<select\b/.test(readFileSync(path, "utf8")),
    );

    expect(remaining).toEqual([]);
  });

  it("does not keep native select rules in the loaded client stylesheets", () => {
    const stylesheetPaths = [
      "src/client/styles.css",
      "src/client/atelier-theme.css",
      "src/client/workspace-theme.css",
    ];
    const remaining = stylesheetPaths.filter((path) => {
      const css = readFileSync(resolve(process.cwd(), path), "utf8");
      return [...css.matchAll(/([^{}]+)\{/g)]
        .map((match) => match[1])
        .some((selector) => selector.split(",").some((part) => nativeSelectPattern.test(part.trim())));
    });

    expect(remaining).toEqual([]);
  });
});
