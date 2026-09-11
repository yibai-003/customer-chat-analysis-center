import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { db } from "../db/client";
import { deleteJob, getJob } from "../db/repositories";

export async function removeJob(jobId: string) {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");
  const sourcePath = (db.prepare("SELECT source_path FROM jobs WHERE id = ?").get(jobId) as { source_path: string } | undefined)?.source_path;
  deleteJob(jobId);
  const paths = [sourcePath, path.join(config.dataDir, "jobs", jobId)];
  await Promise.all(paths.filter(Boolean).map(async (target) => {
    await fs.rm(target!, { recursive: true, force: true });
  }));
}

export async function removeJobs(jobIds: string[]) {
  const ids = [...new Set(jobIds.filter(Boolean))];
  for (const id of ids) await removeJob(id);
  return ids;
}
