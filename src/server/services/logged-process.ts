import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { acquireInstanceLock } from "../instance-lock";
import { assertNoLinks } from "../security/local-files";
import { RotatingLog } from "./rotating-log";

export async function runLoggedProcess(options: {
  command: string; args: string[]; cwd: string; logDir: string;
  maxBytes: number; retention: number; mirror?: boolean;
}) {
  assertNoLinks(options.logDir);
  const lock = await acquireInstanceLock(path.join(options.logDir, ".log-owner"));
  let output: RotatingLog | undefined;
  let errors: RotatingLog | undefined;
  try {
    output = new RotatingLog({ directory: options.logDir, channel: "out", maxBytes: options.maxBytes, retention: options.retention, mirror: options.mirror ? process.stdout : undefined });
    errors = new RotatingLog({ directory: options.logDir, channel: "err", maxBytes: options.maxBytes, retention: options.retention, mirror: options.mirror ? process.stderr : undefined });
    const child = spawn(options.command, options.args, { cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stop = () => { child.kill(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    const finished = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code ?? 1));
    });
    try {
      const results = await Promise.all([finished, pipeline(child.stdout, output), pipeline(child.stderr, errors)]);
      return results[0];
    } catch (error) {
      stop();
      await finished.catch(() => {});
      throw error;
    } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  } finally { output?.destroy(); errors?.destroy(); await lock.release(); }
}
