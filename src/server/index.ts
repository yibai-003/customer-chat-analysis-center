import { validateRuntimeConfig } from "./config";
import { config } from "./config";
import { acquireInstanceLock } from "./instance-lock";
import { projectRoot } from "./environment";
import { initializeEncryptionKey } from "./security/key-manager";

validateRuntimeConfig();
process.chdir(projectRoot);
const lock = await acquireInstanceLock(config.databasePath);
try {
  initializeEncryptionKey({ databasePath: config.databasePath, externalKey: process.env.ENCRYPTION_KEY });
  // Only open/migrate/recover the database after obtaining exclusive process ownership.
  const { startServer } = await import("./startup");
  startServer().once?.("close", () => { void lock.release(); });
} catch (error) { await lock.release(); throw error; }
