import fs from "node:fs";
import { config } from "../config";
import {
  getModelReadinessActions,
  getModelReadinessChecks,
} from "./model-config-service";

export interface ReadinessDependencies {
  dataDir: string;
  minFreeDiskMb: number;
  statfs: (path: string) => { bavail: number | bigint; bsize: number | bigint };
  modelChecks: typeof getModelReadinessChecks;
  modelActions: typeof getModelReadinessActions;
}

export interface ReadinessStatus {
  ready: boolean;
  database: true;
  freeDiskMb: number;
  minFreeDiskMb: number;
  models: { vision: boolean; text: boolean };
  modelChecks: ReturnType<typeof getModelReadinessChecks>;
  actions: ReturnType<typeof getModelReadinessActions>;
}

const defaults: ReadinessDependencies = {
  dataDir: config.dataDir,
  minFreeDiskMb: config.minFreeDiskMb,
  statfs: fs.statfsSync,
  modelChecks: getModelReadinessChecks,
  modelActions: getModelReadinessActions,
};

export function getReadinessStatus(
  dependencies: ReadinessDependencies = defaults,
): ReadinessStatus {
  const disk = dependencies.statfs(dependencies.dataDir);
  const freeDiskMb = Math.floor(
    Number(disk.bavail) * Number(disk.bsize) / 1024 / 1024,
  );
  const modelChecks = dependencies.modelChecks();
  const models = {
    vision: modelChecks.vision.verified,
    text: modelChecks.text.verified,
  };

  return {
    ready: freeDiskMb >= dependencies.minFreeDiskMb && models.vision && models.text,
    database: true,
    freeDiskMb,
    minFreeDiskMb: dependencies.minFreeDiskMb,
    models,
    modelChecks,
    actions: dependencies.modelActions(),
  };
}
