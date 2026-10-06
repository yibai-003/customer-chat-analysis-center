# 客服解析中心项目操作指南

**状态：** 当前操作说明
**适用对象：** 本机开发者、局域网测试人员、部署管理员
**维护日期：** 2026-09-25

## 目的

区分本机开发验证、局域网 HTTP 测试和正式 HTTPS 运行，提供各环境的启动、停止、验收和回退步骤。测试环境不得连接或复制正式数据库、知识目录、加密密钥、账号或模型凭据。

## 实施顺序

### 环境入口

| 环境 | 地址 | 数据位置 | 启停原则 |
| --- | --- | --- | --- |
| 本机验证 | `http://localhost:8787` | 仓库根目录本地 `.env` / `data/` | 需要时在终端启动，按 `Ctrl+C` 停止 |
| 局域网测试 | `http://chat-test.customer.lan:8444` | `deploy/test-data/`、`deploy/test-knowledge/` | 需要验收时手动启动，结束后停止 |
| 正式版 | `https://chat.customer.lan:8443` | `deploy/.env` 指定的正式持久目录 | Docker Desktop 自动恢复；发布才替换镜像 |

`8080` 已从正式入口配置中移除。测试端口 `8444` 使用 HTTP，只供可信局域网验收。

### 镜像对应关系与核对

| 环境 | 应用运行方式 / 镜像 | 代理镜像 | 何时更新 |
| --- | --- | --- | --- |
| 本机验证 | 不使用 Docker 镜像；由 `npm run start` 启动本机 Node 服务 | 无 | 修改源码后重新构建，再启动本机服务 |
| 局域网测试 | `deploy/.env.test` 中 `APP_IMAGE` 指定，默认 `customer-chat-analysis-center:lan-test` | `nginx:latest` | 首次启动或要验证代码改动时运行 `up -d --build` |
| 正式版 | 正式部署脚本生成的带版本和提交号的应用镜像 | `nginx:latest` | 仅通过正式部署脚本发布 |

Docker 镜像是构建时的代码快照。修改工作区源码不会自动改变已有镜像或正在运行的容器；`up -d --no-build` 只启动并复用已有镜像，`up -d --build` 才会按当前工作区重建测试镜像。正式环境不要用测试 Compose 重建，也不要手工给正式镜像重新打 `lan-test` 标签。

查看正式容器当前实际使用的镜像、镜像 ID 和状态：

```powershell
docker inspect `
  --format '容器={{.Name}} 镜像={{.Config.Image}} 镜像ID={{.Image}} 状态={{.State.Status}}' `
  lan-preview customer-chat-analysis-proxy
```

正式应用的镜像标签会随每次发布变化，因此以此命令的结果为准。查看测试栈的 Compose 服务与镜像对应关系：

```powershell
docker compose `
  --project-name customer-chat-analysis-test `
  --env-file deploy/.env.test `
  -f deploy/docker-compose.lan-test.yml `
  images
```

这个命令需要先按“局域网测试首次设置”创建 `deploy/.env.test`。也可以用 `docker image ls customer-chat-analysis-center` 查看本机留存的应用镜像标签；镜像存在不代表对应容器正在运行。

### 本机验证

在仓库根目录首次安装时执行：

```powershell
npm ci
npm run build
```

日常启动已构建的本机版本：

```powershell
npm run start
```

打开 `http://localhost:8787`，停止时回到终端按 `Ctrl+C`。修改前端源码后先运行 `npm run build`，再启动。`scripts/start-local.ps1` 会执行安装检查和构建，适合首次安装或明确需要完整重建时使用，不是快速重启命令。

本机版本读取仓库根目录 `.env`，不要把 `deploy/.env` 复制到这里。默认数据目录是仓库根目录 `data/`，不得改成正式环境的数据路径。

### 修复分支本机验证与数据基线

修复分支的验证不仅需要最新代码，还需要与代码基线匹配的应用数据。板块配置、字段链、提示词、模型服务商、模型 API 配置、平台配置和历史分析任务都保存在 SQLite 或其关联文件中。空数据库只能验证安装流程，不能代表主环境的真实分析行为。

#### 1. 从当前 `main` 创建代码工作树

创建分支前先确认本地 `main` 的提交和未提交改动。若本地 `main` 已有尚未推送但应作为基线的提交，分支必须从本地 `main` 创建，而不是直接从旧的 `origin/main` 创建：

```powershell
git status
git switch main
git rev-parse main
git worktree add .worktrees/<branch-name> main
git -C .worktrees/<branch-name> rev-parse HEAD
```

最后两个提交号必须一致。主工作树中未提交的 `knowledge/catalog.json` 或其他配置改动不会自动进入新分支，是否纳入基线必须明确决定。

#### 2. 从 `main` 生成独立测试数据副本

先暂停主环境正在进行的导入和分析，再在主环境创建经过校验的完整备份：

```powershell
npm.cmd run backup
```

将备份恢复到一个全新的、只供该分支使用的目录，并完成恢复校验：

```powershell
npm.cmd run restore -- "<完整备份目录>" --to "<分支测试数据目录>"
npm.cmd run restore:verify -- "<分支测试数据目录>"
```

完整恢复包会带出数据库、数据库引用的原始文件、已生成导出文件和 `knowledge/catalog.json`。恢复后的 `knowledge/catalog.json` 必须与数据库保持同一备份基线。

完整备份不包含 `.env` 和加密密钥。必须安全保留主环境匹配的 `.secrets/app.db.key.json`，放入恢复副本的 `data/.secrets/`，或为分支配置同一个独立的 `ENCRYPTION_KEY`。密钥不能提交 Git，也不能打印到日志或聊天记录。

#### 3. 为分支设置独立运行参数

分支服务必须使用独立的端口、数据目录和数据库路径，例如 `8790` 及该分支专用数据目录。不要把主环境的 `.env` 原样复制到分支；应创建分支专用配置，避免继承主环境端口、路径或其他运行参数。

分支启动后至少检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8790/api/health
Invoke-RestMethod http://127.0.0.1:8790/api/version
npm.cmd run restore:verify -- "<分支测试数据目录>"
```

`8788` 和 `8790` 不能使用同一个 `app.db`。测试分支可以使用主库的独立副本，但不能与主服务实时共用或直接覆盖主库。主环境配置更新后，需要重新创建或刷新分支数据快照；分支中的测试修改不会自动同步回 `main`。

### 局域网测试首次设置

测试 Compose 和模板已与正式栈分离。测试用 HTTP，因此不需要安装正式 HTTPS 根证书；每台需要测试的电脑仍需能把测试主机名解析到服务器内网 IP。

#### 1. 准备测试环境文件

从仓库根目录复制模板：

```powershell
Copy-Item deploy/.env.test.example deploy/.env.test
```

编辑被忽略的 `deploy/.env.test`，把 `LAN_BIND_ADDRESS` 改成这台 Docker 主机当前固定的局域网 IPv4 地址；并将 `ALLOWED_HOSTS` 和 `ALLOWED_ORIGINS` 中的 `chat-test.example.invalid` 替换为实际测试主机名。本项目当前使用 `chat-test.customer.lan`；在内网 DNS 添加该名称，或在每台测试客户端的 hosts 文件添加：

```text
172.16.20.178 chat-test.customer.lan
```

将示例 IP 替换为实际内网 IP。不要把 `deploy/.env.test` 提交到 Git，也不要填入正式 API Key 或复制正式数据。

#### 2. 限制防火墙范围

在管理员 PowerShell 中，仅对可信局域网开放测试端口：

```powershell
New-NetFirewallRule `
  -DisplayName "客服解析中心 LAN Test HTTP 8444" `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort 8444 `
  -RemoteAddress LocalSubnet `
  -Profile Private
```

如果需要更严格的网络边界，把 `LocalSubnet` 换成实际批准的局域网 CIDR。不要配置路由器端口转发、DMZ 或公网访问。

移除正式入口旧的 `8080` 防火墙规则（如果存在），同样在管理员 PowerShell 执行：

```powershell
Get-NetFirewallRule -DisplayName "客服解析中心 LAN HTTPS 8080" `
  -ErrorAction SilentlyContinue | Remove-NetFirewallRule
```

#### 3. 首次构建并启动

```powershell
docker compose `
  --project-name customer-chat-analysis-test `
  --env-file deploy/.env.test `
  -f deploy/docker-compose.lan-test.yml `
  up -d --build
```

测试应用只绑定宿主机回环端口 `8789`，局域网客户端只能经过测试 Nginx 访问 `8444`。检查状态：

```powershell
docker compose `
  --project-name customer-chat-analysis-test `
  --env-file deploy/.env.test `
  -f deploy/docker-compose.lan-test.yml `
  ps
```

首次使用时，在测试容器内单独创建测试管理员，并在页面配置测试专用模型。密码和模型凭据都不能复用正式环境：

```powershell
docker exec customer-chat-analysis-test npm run bootstrap:admin -- --username admin --password "<测试专用密码>"
```

打开 `http://chat-test.customer.lan:8444`。如果其他设备无法连接，依次检查测试主机名解析、服务器内网 IP、防火墙 TCP `8444` 和测试 Compose 状态。

### 局域网测试日常启停

已有测试镜像时快速启动：

```powershell
docker compose `
  --project-name customer-chat-analysis-test `
  --env-file deploy/.env.test `
  -f deploy/docker-compose.lan-test.yml `
  up -d --no-build
```

代码变更后需要在测试环境验证时，使用 `up -d --build` 重建测试镜像。该命令不会运行正式发布脚本，也不会替换正式容器。

验收完成后停止测试栈：

```powershell
docker compose `
  --project-name customer-chat-analysis-test `
  --env-file deploy/.env.test `
  -f deploy/docker-compose.lan-test.yml `
  stop
```

停止会保留测试数据库与文件。不要对测试栈使用 `down --volumes`；不要把正式数据目录挂载到测试容器。测试容器设置为不自动重启，避免每次 Docker Desktop 启动时额外占用资源。

### 正式版日常启动与发布

Docker Desktop 启动后，正式容器配置为自动恢复。查看运行状态：

```powershell
docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

在输出中确认 `lan-preview` 和 `customer-chat-analysis-proxy` 的状态。

若正式容器确实已停止，才执行启动命令：

```powershell
docker start lan-preview customer-chat-analysis-proxy
```

正式入口始终是 `https://chat.customer.lan:8443`。启动已有容器不会跑测试、构建镜像或更换版本。

只有要发布代码时才运行正式部署流程。它会执行质量检查、构建镜像、替换正式应用并核验运行版本；要求干净工作区：

```powershell
pwsh -File scripts/lan-deploy.ps1 `
  -EnvFile deploy/.env `
  -ContainerName lan-preview `
  -EntryUrl http://127.0.0.1:8788
```

仅 `git push` 不会更新运行中的正式镜像。升级前备份、发布验收和回滚步骤见[局域网部署与单实例运行](lan-deployment.md)。

### 安全与清理

- HTTP 测试流量和会话 Cookie 未加密，只使用虚构或脱敏数据；严禁上传真实聊天截图、客户信息或正式文件。
- 正式版与测试版使用不同主机名、Cookie、数据库、知识目录、加密密钥和模型凭据。不要只依靠端口隔离 Cookie。
- 保持正式入口 HTTPS、管理员认证、用户权限和 Host/Origin 校验；测试版只降低传输层安全，不关闭应用访问控制。
- Docker 镜像清理只考虑未被容器引用的悬空镜像：`docker image prune`。不要用 `docker image prune -a` 或 `docker system prune --volumes` 清理正式镜像、容器、数据卷或回滚资源。
- 不要在测试栈使用生产模型池或真实生产 API 凭据；模型调用可能产生费用。

## 验收

- 本机版本：访问 `http://localhost:8787`，确认页面可打开；健康接口应返回 HTTP 200。
- 局域网测试：`docker compose ... ps` 显示测试应用和代理运行，访问 `http://chat-test.customer.lan:8444`，确认页面及 `/api/health` 可用。
- 正式版：确认正式容器使用预期镜像，`https://chat.customer.lan:8443/api/health` 返回 HTTP 200；发布验收还应按[局域网部署与单实例运行](lan-deployment.md)核对版本、就绪状态和入口资源。
- 不要把 HTTP 测试版的可用性当作正式发布验收；测试使用虚构或脱敏业务数据。

## 回退

- 局域网测试有问题时，按“局域网测试日常启停”停止测试栈；测试数据保留。修复或切回代码版本后，重新运行 `up -d --build`，不得切换到正式数据目录。
- 正式版发布失败时，使用部署脚本输出的旧镜像回滚命令，或按[局域网部署与单实例运行](lan-deployment.md)中的“升级与回滚”步骤执行。不要手工删除旧镜像或改写正式持久数据。
- 本机验证异常时，按 `Ctrl+C` 停止本机进程；保留 `data/`，检查本机 `.env` 后再启动。不要用测试或正式环境的数据覆盖本机数据。
