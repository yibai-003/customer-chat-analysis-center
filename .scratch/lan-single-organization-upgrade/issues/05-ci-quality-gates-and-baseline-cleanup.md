# 05: CI 质量闸门与现有基线清理

**What to build:** 清理当前异步测试警告和安装一致性问题，并建立从干净检出运行的 CI 质量闸门，产出已验证的构建与镜像工件，但不自动部署到局域网主机。

**Blocked by:** None (can start immediately)

**Status:** done (2026-09-17)

- [x] 修复现有异步测试未等待的警告，使测试输出不存在已知未处理异步警告。
- [x] 修复锁文件与原生依赖安装检查不一致的问题，使 `npm ci` 和 `npm run check:installation` 在干净环境通过。
- [x] CI 在干净检出中依次执行 `npm ci`、安装检查、测试、类型检查、lint、构建、数据库检查和冒烟检查。
- [x] 任一质量命令失败时 CI 失败，不能继续生成发布候选。
- [x] CI 在质量闸门通过后构建生产镜像或等价发布工件，记录版本/提交来源；不配置自动推送生产或自动部署。
- [x] CI 说明文档记录所需 Node 版本、缓存边界、证书要求和失败排查入口。

**实现摘要（2026-09-17）：**
- 基线核验：`npx vitest run` 完整输出 82 文件 / 622 用例全部通过，无未处理异步警告或 stderr 噪声，无需改动测试；`package-lock.json` 中 `better-sqlite3@13.0.3` 为官方源且 `gypfile:false`，全部 resolved URL 均为 `registry.npmjs.org`。
- 干净环境验证：复制仓库（排除 `node_modules`/`data`/`.git`）后依次通过 `npm ci`、`npm run check:installation`、`npm test`、`npm run typecheck`、`npm run lint`、`npm run build`、`npm run db:init`、`npm run db:check`（版本 17、外键 0）、`npm run smoke`。
- `.github/workflows/quality-gates.yml`：`quality` 作业按序执行 9 个命令，任一步失败即失败；`release-artifact` 作业 `needs: quality` 且跳过 PR，新增 `docker build`（本地实测镜像构建成功，不推送、不登录仓库）并把镜像标签与 ID 写入 `manifest.json`，与 tar.gz 发布工件一起上传，保留 30 天。
- 新增 `.dockerignore`：排除 `node_modules`、`data`、`dist`、`.git`、`.env*` 与本地样本，避免主机数据/密钥进入构建上下文。
- `docs/guides/ci-quality-gates.md` 同步更新：命令清单、镜像构建与无推送说明、缓存边界（npm 缓存 + runner 本地镜像构建）、证书要求（仅公开源）、失败排查入口（含 Windows 本地 `npm ci` 被运行中进程占用报 `EPERM` 的处理）与回退方式。

