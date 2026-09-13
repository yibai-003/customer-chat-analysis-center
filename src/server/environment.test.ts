import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvironment, projectRoot } from "./environment";
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
describe("project environment", () => {
  it("resolves configured data paths from the project even when launched elsewhere", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "env-cwd-")); folders.push(folder);
    const loader = pathToFileURL(path.join(projectRoot, "node_modules/tsx/dist/loader.mjs")).href;
    const module = pathToFileURL(path.join(projectRoot, "src/server/config.ts")).href;
    const script = `import { config } from ${JSON.stringify(module)}; console.log(JSON.stringify([config.dataDir, config.databasePath]));`;
    const result = await promisify(execFile)(process.execPath, ["--import", loader, "--input-type=module", "-e", script], {
      cwd: folder, env: { ...process.env, NODE_ENV: "test", DATA_DIR: "./custom-data", DATABASE_PATH: "./custom-data/app.db" },
      windowsHide: true, timeout: 10_000,
    });
    expect(JSON.parse(result.stdout.trim())).toEqual([path.join(projectRoot, "custom-data"), path.join(projectRoot, "custom-data/app.db")]);
  }, 15_000);
  it("loads supported keys, preserving explicit environment and ignoring process injection", () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "env-config-")); folders.push(folder);
    const file = path.join(folder, ".env");
    fs.writeFileSync(file, 'PORT=9000\nDATA_DIR="./custom-data"\nBACKUP_RETENTION=3\nNODE_OPTIONS=--require=malicious\nPATH=unexpected\n');
    const env: NodeJS.ProcessEnv = { PORT: "8787" };
    loadEnvironment(file, env);
    expect(env).toEqual({ PORT: "8787", DATA_DIR: "./custom-data", BACKUP_RETENTION: "3" });
  });
  it("does not create a missing env file", () => {
    const env: NodeJS.ProcessEnv = {};
    loadEnvironment(path.join(os.tmpdir(), "missing-env-" + Date.now()), env);
    expect(env).toEqual({});
  });
});
