import { validateRuntimeConfig } from "./config";
import { config } from "./config";
import { acquireInstanceLock } from "./instance-lock";

validateRuntimeConfig();
const lock = await acquireInstanceLock(config.databasePath);
try {
  // Only open/migrate/recover the database after obtaining exclusive process ownership.
  const { startServer } = await import("./startup");
  startServer().once?.("close", () => { void lock.release(); });
} catch (error) { await lock.release(); throw error; }
