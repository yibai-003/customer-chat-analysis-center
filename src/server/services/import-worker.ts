import fs from "node:fs/promises";
import path from "node:path";
import { getImportJob, getSection, claimImportJob, listImportJobs, updateImportJob } from "../db/repositories";
import { importWorkbookStreaming } from "./streaming-xlsx-import-service";

const running = new Set<string>();

export function startImportJob(importJobId: string) {
  if (running.has(importJobId)) return;
  running.add(importJobId);
  void runImportJob(importJobId).finally(() => running.delete(importJobId));
}

export async function runImportJob(importJobId: string) {
  const importJob = getImportJob(importJobId);
  if (!importJob) throw new Error("导入任务不存在");
  if (!claimImportJob(importJobId)) return getImportJob(importJobId)!;
  try {
    const section = importJob.sectionId ? getSection(importJob.sectionId) : undefined;
    if (importJob.sectionId && !section) throw new Error("导入任务对应的解析板块不存在");
    const created = await importWorkbookStreaming(
      importJob.sourcePath,
      importJob.filename,
      section && {
        id: section.id,
        name: section.name,
        sectionConfigVersionId: importJob.sectionConfigVersionId ?? section.currentVersionId ?? undefined,
      },
      (progress) => {
        updateImportJob(importJobId, {
          totalImages: progress.totalImages,
          processedImages: progress.processedImages,
          processedRecords: progress.processedImages,
          currentSheet: progress.currentSheet,
          currentRow: progress.currentRow,
        });
      },
      importJob.platformId && importJob.platformName && importJob.platformCode
        ? { id: importJob.platformId, name: importJob.platformName, code: importJob.platformCode }
        : undefined,
    );
    updateImportJob(importJobId, {
      status: "completed",
      jobId: created.id,
      sourcePath: created.sourcePath,
      totalImages: created.totalRecords,
      processedImages: created.totalRecords,
      totalRecords: created.totalRecords,
      processedRecords: created.totalRecords,
      errorMessage: null,
    });
    await fs.rm(path.dirname(importJob.sourcePath), { recursive: true, force: true });
    return getImportJob(importJobId)!;
  } catch (error) {
    updateImportJob(importJobId, {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "导入失败",
    });
    return getImportJob(importJobId)!;
  }
}

export function recoverImportJobs() {
  for (const job of listImportJobs()) {
    if (job.status === "processing") updateImportJob(job.id, { status: "queued" });
    if (job.status === "queued" || job.status === "processing") startImportJob(job.id);
  }
}
