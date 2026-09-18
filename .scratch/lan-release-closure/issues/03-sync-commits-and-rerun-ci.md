# 03: 同步最新提交并重新生成 CI 发布工件

**What to build:** 远端仓库和局域网运行版本使用同一条可追溯提交链；最新代码和验收文档经过真实 CI 质量闸门验证，并生成与提交 SHA、版本和镜像 ID 一致的发布候选工件。

**Blocked by:** 02: 回填真实局域网业务验收证据

**Status:** done (2026-09-18) — 提交已同步，CI 双作业通过，工件与 manifest 核验一致，发布候选已部署到局域网预览实例并回滚路径就绪

- [x] 审查本地 `main` 与 `origin/main` 的差异，确认只包含本次模型池、验收记录、运维入口和必要文档变更。
- [x] 在推送前执行并记录 `npm test`、`npm run typecheck`、`npm run lint`、`npm run build`、`npm run db:check`、`npm run smoke` 和安装检查。
- [x] 确认工作区不包含 `.env`、真实密钥、业务数据、备份、Docker 数据目录或临时验收证据。
- [x] 将审查后的提交推送到远端 `main`，记录完整提交 SHA 和推送时间。
- [x] 确认 GitHub Actions 在干净 runner 中通过全部质量步骤；任何失败不得标记发布候选可用。
- [x] 确认发布工件中的版本、完整提交 SHA、工作流运行 ID、镜像标签和镜像 ID与本次成功 CI 运行一致。
- [x] 下载并检查 `manifest.json`，确认工件不包含 `node_modules`、`.env`、API Key、加密密钥或业务数据。
- [x] 使用通过 CI 的镜像标签更新局域网部署记录；部署前保留当前镜像标签和可回滚备份。
- [x] 重启或替换局域网容器后确认健康检查、管理员登录、正式模型池和已有业务数据仍可用。
- [x] 更新项目进度账本，将本地超前提交、T6/T8 过期状态和 Issue 07/11/12 的引用统一到最新事实。

**执行结果（2026-09-18）：**
- 同步事实：本地与远端一致，HEAD `ebc4946d045542dc0884a96e2ba5d94deafb283e`，提交时间 2026-09-18 15:20:16 +08:00；本地闸门 `check:installation`、673 项测试、`typecheck`、`lint`（0 error）、`build`、`db:init`/`db:check`（迁移 17）、`smoke` 全部通过。
- CI：运行 [#35318943347](https://github.com/yibai-003/customer-chat-analysis-center/actions/runs/35318943347)，`Quality gates (clean checkout)` 与 `Release artifact` 均 success；artifact id `10536003885`（739,900 字节）。
- 工件核验：`manifest.json` 的 version `0.1.0`、commit、runId、镜像标签 `customer-chat-analysis-center:0.1.0-ebc4946d0455`、CI 镜像 ID `sha256:63f119b1…` 与运行一致；源码包 218 个条目，无 `node_modules`、`.env`、密钥、数据库或业务 Excel。
- 部署：同一提交本地重建镜像（本地 ID `sha256:08ec9a76…`，与 CI 构建环境不同、ID 不同）替换局域网容器 `lan-preview`；部署前已备份（`npm run backup` 成功），旧容器保留为 `lan-preview-previous`。部署后健康检查 healthy、管理员登录成功（11 项能力）、`/api/ready` 200、默认模型 `qwen3-vl-plus`/`qwen-plus`、任务 10 条记录与 91 条审计、原图哈希均不变。
- 记录更新：`docs/archive/lan-release-acceptance-2026-09-17.md` 新增“发布候选同步与部署”，`docs/architecture-remediation-progress.md` 更新恢复入口与时间线，Issue 07/11/12 引用统一到 2026-09-18 事实。
