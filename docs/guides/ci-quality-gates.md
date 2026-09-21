# CI 质量闸门与发布工件

## 目的

在 GitHub Actions 的干净检出上自动执行全部质量命令。任一质量命令失败即整个工作流失败，不生成发布候选；闸门全部通过后才在 `main` 上构建生产镜像并打包带版本与提交来源记录的发布工件。工作流不推送任何镜像，也不自动部署到局域网主机——局域网部署仍由人工按部署文档执行。

对应规格：局域网单组织多用户版本 Issue 05（CI 质量闸门与现有基线清理）。

## 实施顺序

工作流文件：`.github/workflows/quality-gates.yml`。触发方式：push / pull_request 到 `main`，以及手动 `workflow_dispatch`。

`quality` 作业（干净检出、0 级步骤独立）：

1. `actions/checkout` + `actions/setup-node`（Node 22，npm 缓存）
2. `npm ci` —— 严格按锁文件安装，校验包完整性
3. `npm run check:installation` —— 锁文件官方源与 `gypfile=false` 标记、SQLite/FTS5 实际可用
4. `npm test`
5. `npm run typecheck`
6. `npm run lint`
7. `npm run build`
8. `npm run db:init` —— 干净检出没有数据库，先用默认 `./data` 目录创建并迁移新库
9. `npm run db:check`
10. `npm run smoke`

`release-artifact` 作业 `needs: quality`，只在闸门通过后运行，且跳过 PR（`if: github.event_name != 'pull_request'`）：

1. `npm ci` + `npm run build`
2. `docker build -t customer-chat-analysis-center:<version>-<commit12> .` —— 按 `Dockerfile` 构建生产镜像，并注入 `APP_VERSION`、完整 `APP_COMMIT_SHA`、`APP_BUILD_TIME`、`APP_IMAGE`；**只构建、不打标签推送、不登录任何镜像仓库**
3. 打包 `dist`、`src/server`、`src/shared`、`knowledge`、`config`、`package.json`、`package-lock.json` 为 `customer-chat-analysis-center-<version>-<commit12>.tar.gz`（版本取自 `package.json`，仓库内为 `0.1.0`）
4. 使用 `docker save | gzip` 生成可导入的 `customer-chat-analysis-center-<version>-<commit12>.image.tar.gz`
5. 生成 `manifest.json`（版本、完整 commit、ref、runId、Node 版本、镜像标签、镜像 ID、镜像归档文件名、构建时间、`docker load` 命令和运行要求），经 `upload-artifact` 保留 30 天

工件目录使用非隐藏的 `release/`（upload-artifact 默认跳过隐藏文件/目录）；`.dockerignore` 排除 `node_modules`、`data`、`dist`、`.git`、`.env*` 与本地样本，保证构建上下文不含主机数据或密钥。工件与镜像均无任何推送/部署步骤。

主机侧必须下载同一个发布工件中的 `manifest.json` 和 `*.image.tar.gz`，先执行清单中的 `docker load -i <imageArchive>`，再用 `docker image inspect <image> --format "{{.Id}}"` 比对清单的 `imageId`。镜像 ID 不一致时停止部署，不得只凭镜像标签继续。

## 需要的版本

- 运行环境：Node.js 22.x（要求 >=22.12.0，`package.json` `engines` 已声明）；CI 使用 22.x 最新补丁，npm 随 Node 自带。
- 本机复现请使用相同的大版本；旧 Node 可能导致原生依赖预编译下载不匹配。

## 缓存边界

- `setup-node` 的 npm 缓存按 `package-lock.json` 哈希、操作系统和运行环境作用域区分；锁文件变化即自动失效。缓存只加速下载，不影响安装正确性。
- 每次运行都是干净的 `git checkout`，`node_modules` 不跨运行复用；`npm ci` 强制按锁文件重建并校验完整性，不允许把本机 `node_modules` 复制进 CI。
- 同一 ref 并发运行时取消旧运行（`concurrency`），避免重复占用 runner 和生成多余工件。
- 发布工件不包含 `node_modules`、密钥、`.env` 或任何主机数据。
- 生产镜像在 runner 本地重新构建（多阶段 `npm ci`），不使用外部镜像仓库作为缓存或推送目标；基础镜像 `node:22.23.2-bookworm-slim` 为 Docker Hub 公共镜像。

## 证书要求

- CI 只依赖公开官方源：`https://registry.npmjs.org/`（锁文件全部为官方 URL，`check:installation` 强制校验）和 better-sqlite3 官方预编译发布。因此 CI 不需要内网代理、私有 npm 源或企业 CA。
- 不把局域网 TLS 证书、`ENCRYPTION_KEY`、密钥文件放入仓库或 CI secrets。TLS 证书是主机侧反向代理的部署责任（见局域网部署文档），CI 永远不接触证书与密钥。
- 证书类错误先查系统时钟、代理配置与可信 CA（如 `NODE_EXTRA_CA_CERTS` 仅指向可信来源）；禁止通过禁用 TLS 校验绕过。

## 验收

- 9 个命令按序执行（`npm ci`、安装检查、测试、类型检查、lint、构建、`db:init`、`db:check`、冒烟），任一失败整条工作流失败，`release-artifact` 因 `needs` 依赖不会运行。
- `main` 成功运行后产生带版本与提交来源的发布工件、可导入镜像归档和 `manifest.json`。
- 工作流无自动推送、无自动部署步骤。

## 失败排查入口

| 命令 | 常见失败 | 入口 |
| --- | --- | --- |
| `npm ci` | 网络/原生依赖 | 重试；清对应 npm 缓存；确认锁文件 `gypfile=false` 未丢失；不要用 `npm install` 替代或手改 `node_modules`。Windows 本地若服务端或测试进程仍在运行，原生模块文件被占用会报 `EPERM`，先停止服务再执行；CI 干净检出不受影响 |
| `check:installation` | 报“Lockfile lost gypfile=false”或非官方 URL | 恢复经审查的锁文件后重跑，见 [官方依赖源与可复现安装](reproducible-installation.md) |
| `npm test` | 单测断言 | 本地 `npx vitest run <文件>` 复现；时间相关用例用 `vi.setSystemTime` 固定时钟，不依赖真实日期 |
| `typecheck` / `lint` | 类型或 lint 错误 | `tsc --noEmit` / `oxlint src`；当前 lint 均为 warning，不阻塞 |
| `build` | vite 构建错误 | 本地 `npm run build`；`dist` 为 gitignore 产物 |
| `db:check` | 数据库不存在 | 先 `npm run db:init`（CI 已自动执行）；检查 `DATA_DIR`/`DATABASE_PATH` |
| `smoke` | 端口占用/启动超时 | `SMOKE_TIMEOUT_MS` 调大；CI 每次使用隔离临时目录，本地复现可用 `scripts/start-local.ps1` 或 `.cmd` |

## 回退

删除 `.github/workflows/quality-gates.yml` 即回到无 CI 状态（质量命令仍可本地执行，行为与引入前一致）；不涉及数据、密钥或部署配置变更。
