import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { it, expect } from "vitest";

it("recovers an actual crashed process immediately without losing completed records", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "restart-recovery-"));
  const databasePath = path.join(directory, "app.db");
  const children: ChildProcess[] = [];
  const script = `
    import { acquireInstanceLock } from './src/server/instance-lock.ts';
    await acquireInstanceLock(process.env.DATABASE_PATH);
    const { db, initDb } = await import('./src/server/db/client.ts');
    const repo = await import('./src/server/db/repositories.ts');
    initDb();
    if (process.argv[1] === 'create') {
      const job = repo.createJob('test.xlsx','test.xlsx',{ id:'refund',name:'refund' });
      repo.addRecords(job.id,[1,2].map(rowNumber=>({sheetName:'s',rowNumber,anchor:{},sourceFields:{},imagePath:'test.png'})));
      const records = repo.listRecords(job.id);
      repo.updateRecord(records[0].id,{status:'completed'});
      repo.acquireJobRun(job.id);
      repo.updateRecord(records[1].id,{status:'processing'});
      process.send({created:true});
    } else {
      repo.recoverStaleJobRuns();
      const jobs = repo.listJobs();
      process.send({status:jobs[0].status,completed:jobs[0].completedRecords,failed:jobs[0].failedRecords,processing:jobs[0].processingRecords,locks:repo.countActiveJobRuns()});
    }
    setInterval(()=>{},1000);
  `;
  const start = async (mode: string) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, mode], {
      cwd: process.cwd(), env: { ...process.env, DATA_DIR: directory, DATABASE_PATH: databasePath }, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    const result = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Child startup timed out")), 8000);
      child.once("message", message => { clearTimeout(timeout); resolve(message); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("Child exited early")); });
    });
    return { child, result };
  };
  try {
    const initial = await start("create"); expect(initial.result.created).toBe(true);
    const exited = once(initial.child, "exit"); initial.child.kill("SIGKILL"); await exited;
    const restart = await start("recover");
    expect(restart.result).toEqual({ status: "failed", completed: 1, failed: 1, processing: 0, locks: 0 });
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
