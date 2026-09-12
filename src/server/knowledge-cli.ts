import { execFileSync } from "node:child_process";
import { initializeKnowledgeSync, KnowledgeSync } from "./services/knowledge/knowledge-sync-service";
import { initDb } from "./db/client";

function git(...args: string[]) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
}

try {
  const action = process.argv[2] ?? "export";
  if (!["export", "push", "restore"].includes(action)) throw new Error("Usage: knowledge-cli.ts export|push|restore");
  if (action === "restore") {
    initDb({ preserveConfiguration: true });
    console.log(new KnowledgeSync().restore());
    console.log("知识库已从仓库快照恢复，旧数据库备份位于 data/backups。请重启正在运行的服务。");
  } else {
    const sync = initializeKnowledgeSync();
    console.log(sync.export());
  }
  if (action === "push") {
    const branch = git("branch", "--show-current");
    if (!branch) throw new Error("请先切换到需要同步的 Git 分支。");
    const remote = git("remote", "get-url", "origin");
    if (!/^(https:\/\/github\.com\/|git@github\.com:)/.test(remote)) throw new Error("origin 必须指向目标 GitHub 仓库。");
    git("add", "--", "knowledge/catalog.json");
    if (git("diff", "--cached", "--name-only", "--", "knowledge/catalog.json")) {
      git("commit", "--only", "-m", "Sync knowledge catalog", "--", "knowledge/catalog.json");
    }
    // No force push or automatic merge: concurrent remote edits must be reviewed first.
    console.log(git("push", "origin", branch));
    console.log("知识库已同步到 GitHub。");
  }
} catch (error) {
  const failure = error as Error & { stderr?: string | Buffer };
  console.error(failure.stderr?.toString() || failure.message);
  console.error("快照保留在 knowledge/catalog.json。请检查 Git 安装、登录、分支及远端更新后重试。");
  process.exitCode = 1;
}
