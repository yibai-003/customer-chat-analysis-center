import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const require = createRequire(new URL("package.json", root));
try {
  const lock = JSON.parse(fs.readFileSync(new URL("package-lock.json", root), "utf8"));
  const sqlite = lock.packages["node_modules/better-sqlite3"];
  if (sqlite?.version === "13.0.3" && sqlite.gypfile !== false) {
    throw new Error("Lockfile lost better-sqlite3 gypfile=false; restore the reviewed lockfile before npm ci.");
  }
  for (const item of Object.values(lock.packages)) {
    if (item.resolved && new URL(item.resolved).origin !== "https://registry.npmjs.org") throw new Error("Lockfile contains a non-official dependency URL.");
  }
  const Database = require("better-sqlite3");
  const database = new Database(":memory:");
  try {
    database.exec("CREATE VIRTUAL TABLE installation_check USING fts5(content); INSERT INTO installation_check VALUES('ready')");
    if (database.prepare("SELECT count(*) AS n FROM installation_check WHERE installation_check MATCH 'ready'").get().n !== 1) throw new Error("SQLite FTS5 verification failed.");
    console.log(JSON.stringify({ project: fileURLToPath(root), node: process.version, sqlite: database.prepare("SELECT sqlite_version() AS version").get().version, fts5: true, officialRegistry: true }));
  } finally { database.close(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Installation check failed");
  process.exitCode = 1;
}
