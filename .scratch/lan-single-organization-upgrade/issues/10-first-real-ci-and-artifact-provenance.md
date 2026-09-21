# 10: 首次真实 CI 与发布工件追溯

**What to build:** 将当前局域网实现及质量工作流完整纳入版本控制，在远端执行第一次真实 CI，并验证发布候选工件与通过质量闸门的提交、镜像标签和镜像 ID 一致。

**Blocked by:** None (can start immediately)

**Status:** done (2026-09-18)

- [x] 审查当前工作区，将局域网实现、迁移、测试、Docker、部署、运维文档和 CI 工作流纳入提交；不得提交 `.env`、真实密钥、业务数据、备份、测试证据中的敏感值或本地临时目录。
- [x] 推送的提交在干净的 GitHub Actions runner 中依次通过 `npm ci`、`check:installation`、测试、类型检查、lint、构建、数据库初始化/检查和冒烟检查。
- [x] 任一质量步骤失败时发布候选作业不会运行或不会产生可误用的成功工件。
- [x] 发布候选作业构建生产镜像但不自动部署，不登录或推送未批准的镜像仓库。
- [x] 下载并检查发布工件中的 `manifest.json`，确认完整提交 SHA、版本、工作流运行 ID、镜像标签和镜像 ID 与本次成功运行一致。
- [x] 工件包含启动所需的已构建资产或明确依赖镜像运行，不把一个缺少运行文件的源码压缩包描述为可直接部署包。
- [x] 首次 CI 运行 URL、提交 SHA、工件名称、清单摘要和检查日期记录到局域网发布验收文档。
- [x] 本地与 CI 的 Node 主版本、锁文件和迁移版本一致；发现平台差异时修复后重新运行，不以本地通过替代 CI 通过。

**实现摘要（2026-09-18）：**
- 提交与推送：`1f93991` 将局域网实现（身份/会话、授权、审计、管理界面、备份恢复、TLS 接入、CI/部署/运维文档，共 106 个文件）纳入版本控制；`git status` 与敏感路径扫描确认未包含 `.env`、`deploy/.env`、`data/`、备份、密钥或临时目录。后续修复提交 `3acf449`、`9e25060`、`c9f204f`、`b4341f3` 逐项解决 CI 暴露的问题。
- 平台差异修复（先本地 Node 22 + `TZ=UTC` 复现，再推 CI）：`ModelConfigDialog` 的额度到期断言依赖本地时区；`batch-analysis-service` 的 500ms 竞态预算在慢 runner 上过紧；`field-analysis-service` 默认 5s 超时导致取消上下文跨用例泄漏。修复后本地 Node 22.22.2（与 CI 同主版本）全套闸门通过。
- 发布工件修复：`package.json` 缺失 `version` 导致镜像标签为 `undefined-...`，已补 `0.1.0` 并同步锁文件根版本；发布暂存目录由隐藏的 `.release/` 改为 `release/`（`upload-artifact@v4` 默认跳过隐藏路径），并在 manifest 中标注运行要求（`npm ci` + Node 22.12+ 或直接运行镜像）。
- 首次成功运行：run `35294240397`（提交 `b4341f3ce74db5d9876615bac82ade72af38023c`）——质量作业 9 项全部 success（node `v22.23.2`、迁移版本 17），发布作业完成镜像构建（无推送）与工件上传；工件 `customer-chat-analysis-center-release-candidate`（id `10526444673`，737551 字节，摘要 `sha256:b4f6d2347edf0655c0dab1bda0f68580d15e958a76697a9b7ca530ab0637a490`）；manifest 中 version/commit/runId/image/imageId 与运行日志一致，镜像 ID `sha256:1b9bcff0...`；工件解包含 `dist` 构建资产且不含 `node_modules`/`.env`。
- 失败运行均未产出候选工件（发布作业按 `needs` 跳过），记录已写入 `docs/archive/lan-release-acceptance-2026-09-17.md` 的“首次真实 CI 与发布工件”一节。

**2026-09-21 当前提交复跑：**

- 提交 `b11b8d08d8b4aba1a96a1b14aa33227f95f71368` 已推送到 `main`，GitHub Actions 运行 `35565226085`（run #18）完成且结论为 `success`。
- `Quality gates (clean checkout)` job `106225587111` 与 `Release artifact` job `106225721722` 均成功。
- 发布候选工件 `customer-chat-analysis-center-release-candidate` 的 id 为 `10623912039`，工件摘要为 `sha256:22563f7a3cb05103e3af00e89f64a2017deb16d9b5c094cfecb57fccbc1cc5fd`，证据见 `.scratch/lan-single-organization-upgrade/evidence/ci-2026-09-21-run18.json`。
- 按工作流规则，本次 runner 内构建的镜像标签应为 `customer-chat-analysis-center:0.1.0-b11b8d08d8b4`；工作流不推送镜像仓库，正式主机仍需取得可部署镜像及其不可变 `imageId` 后才能完成现场升级/回滚。
