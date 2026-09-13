import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleBackups } from "./backup-scheduler";
import fs from "node:fs/promises";
import { verifyBackup } from "./backup-service";
vi.mock("node:fs/promises", () => ({ default: { readdir: vi.fn() } }));
vi.mock("./backup-service", async importOriginal => {
  const original = await importOriginal<typeof import("./backup-service")>();
  return { ...original, verifyBackup: vi.fn() };
});
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.resetAllMocks(); });
describe("scheduled verified backups", () => {
  it("catches up on startup, prevents overlapping work and cleans up on close", async () => {
    vi.useFakeTimers(); vi.mocked(fs.readdir).mockResolvedValue([]);
    let finish!: () => void;
    const create = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    stop = scheduleBackups({ root: "test", create, busy: () => false, log: vi.fn(), hours: 1 });
    await vi.advanceTimersByTimeAsync(0); expect(create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120000); expect(create).toHaveBeenCalledTimes(1);
    finish(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3500000); expect(create).toHaveBeenCalledTimes(1);
    stop(); await vi.advanceTimersByTimeAsync(3600000); expect(create).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not duplicate a recent verified backup after restarting", async () => {
    vi.useFakeTimers();
    vi.mocked(fs.readdir).mockResolvedValue(["full-recent"] as any);
    vi.mocked(verifyBackup).mockResolvedValue({ createdAt: new Date().toISOString() } as any);
    const create = vi.fn().mockResolvedValue({});
    stop = scheduleBackups({ root: "test", create, busy: () => false, log: vi.fn(), hours: 1 });
    await vi.advanceTimersByTimeAsync(1000); expect(create).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3600000); expect(create).toHaveBeenCalledTimes(1);
  });
  it("defers while busy and retries after failure rather than recording success", async () => {
    vi.useFakeTimers(); vi.mocked(fs.readdir).mockResolvedValue([]);
    let busy = true;
    const create = vi.fn().mockRejectedValueOnce(new Error("Disk full")).mockResolvedValue({});
    const log = vi.fn();
    stop = scheduleBackups({ root: "test", create, busy: () => busy, log });
    await vi.advanceTimersByTimeAsync(60000); expect(create).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(60000); expect(create).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Disk full"));
    await vi.advanceTimersByTimeAsync(60000); expect(create).toHaveBeenCalledTimes(2);
  });
});
