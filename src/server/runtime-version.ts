import fs from "node:fs";
import path from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { projectRoot } from "./environment";

export interface RuntimeVersion {
  version: string;
  commitSha: string;
  buildTime: string;
  image: string;
  assets: { scripts: string[]; styles: string[] };
}

export interface RuntimeVersionOptions {
  distDir?: string;
  env?: NodeJS.ProcessEnv;
}

function entryAssets(html: string) {
  const scripts = [...html.matchAll(/<script[^>]+src=["']\/?([^"']+\.js)["']/g)]
    .map((match) => match[1]);
  const styles = [...html.matchAll(/<link[^>]+href=["']\/?([^"']+\.css)["']/g)]
    .map((match) => match[1]);
  return { scripts: [...new Set(scripts)], styles: [...new Set(styles)] };
}

export function readRuntimeVersion(options: RuntimeVersionOptions = {}): RuntimeVersion {
  const env = options.env ?? process.env;
  const distDir = options.distDir ?? path.join(projectRoot, "dist");
  const indexPath = path.join(distDir, "index.html");
  const html = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "";
  return {
    version: env.APP_VERSION || packageJson.version,
    commitSha: env.APP_COMMIT_SHA || "development",
    buildTime: env.APP_BUILD_TIME || "development",
    image: env.APP_IMAGE || "development",
    assets: entryAssets(html),
  };
}
