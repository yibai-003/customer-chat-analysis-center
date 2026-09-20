import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runReadinessCli } from "./readiness-cli";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "../..");

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runDirectCli(root: string, databasePath: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/server/readiness-cli-entry.ts"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATA_DIR: path.join(root, "data"),
        DATABASE_PATH: databasePath,
      },
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    },
  );
}

function expectSafeDirectFailure(
  result: SpawnSyncReturns<string>,
  temporaryRoot: string,
) {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  const lines = result.stdout.trim().split(/\r?\n/);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toEqual({
    ready: false,
    database: false,
    error: "Readiness check failed",
  });
  expect(result.stdout).not.toContain(temporaryRoot);
  expect(result.stderr).not.toContain(temporaryRoot);
  expect(result.stderr).toBe("");
}

describe("readiness CLI", () => {
  it("prints JSON and returns zero for a ready instance", () => {
    const write = vi.fn();
    const status = { ready: true, database: true };

    expect(runReadinessCli({ provider: () => status as never, write })).toBe(0);
    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject(status);
  });

  it("returns one for a non-ready instance", () => {
    expect(runReadinessCli({
      provider: () => ({ ready: false }) as never,
      write: () => undefined,
    })).toBe(1);
  });

  it("prints safe failure JSON and returns one when the provider throws", () => {
    const write = vi.fn();

    expect(runReadinessCli({
      provider: () => {
        throw new Error("database C:/private/customer/app.db apiKey=secret");
      },
      write,
    })).toBe(1);

    expect(write).toHaveBeenCalledTimes(1);
    const output = write.mock.calls[0][0];
    expect(JSON.parse(output)).toEqual({
      ready: false,
      database: false,
      error: "Readiness check failed",
    });
    expect(output).not.toMatch(/private|apiKey|secret|stack/i);
  });

  it("prints safe failure JSON when the readiness status cannot be serialized", () => {
    const write = vi.fn();
    const circular: Record<string, unknown> = { ready: false, database: true };
    circular.self = circular;

    expect(runReadinessCli({
      provider: () => circular as never,
      write,
    })).toBe(1);

    expect(JSON.parse(write.mock.calls[0][0])).toEqual({
      ready: false,
      database: false,
      error: "Readiness check failed",
    });
  });

  it("prints failure JSON when directly executed with an uninitialized database", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-cli-"));
    roots.push(root);
    const result = runDirectCli(root, path.join(root, "data", "app.db"));

    expectSafeDirectFailure(result, root);
  });

  it("prints failure JSON when the database cannot be opened during module loading", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-cli-"));
    roots.push(root);
    const databasePath = path.join(root, "database-directory");
    fs.mkdirSync(databasePath);
    const result = runDirectCli(root, databasePath);

    expectSafeDirectFailure(result, root);
  });
});
