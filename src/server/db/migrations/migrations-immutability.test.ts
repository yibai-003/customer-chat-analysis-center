import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = path.join(process.cwd(), "src/server/db/migrations");
const lockPath = path.join(migrationsDir, "migrations.lock.json");

function frozenDigest(file: string) {
  const source = fs.readFileSync(path.join(migrationsDir, file), "utf8").replace(/\r\n/g, "\n");
  return crypto.createHash("sha256").update(source).digest("hex");
}

function numberedMigrations() {
  return fs.readdirSync(migrationsDir).filter((name) => /^\d{3}-.+\.ts$/.test(name)).toSorted();
}

function readLock() {
  expect(fs.existsSync(lockPath)).toBe(true);
  return JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, string>;
}

describe("frozen migrations", () => {
  it("requires a frozen digest for every numbered migration", () => {
    const lock = readLock();
    const missing = numberedMigrations().filter((file) => !lock[file]);
    expect(missing).toEqual([]);
  });

  it("rejects changes to already applied migrations", () => {
    const lock = readLock();
    const changed = numberedMigrations().filter((file) => lock[file] && lock[file] !== frozenDigest(file));
    expect(changed).toEqual([]);
  });

  it("keeps the lock in sync with the migration directory", () => {
    const lock = readLock();
    const extra = Object.keys(lock).filter((file) => !numberedMigrations().includes(file));
    expect(extra).toEqual([]);
  });
});
