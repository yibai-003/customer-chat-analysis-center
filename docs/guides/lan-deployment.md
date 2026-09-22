# 局域网部署与单实例运行

本指南对应 `.scratch/lan-single-organization-upgrade/issues/04-lan-image-and-single-instance-runtime.md`：把应用封装为可在固定局域网主机运行的生产镜像和声明式运行配置。账号、权限与审计属于后续单元；本单元只管运行层。

## 镜像契约

- `Dockerfile` 多阶段构建：固定基础镜像 `node:22.23.2-bookworm-slim`；`npm ci` 按锁文件安装（原生模块缺失预编译时在容器内编译）；`npm run build` 产出前端资源。
- 运行阶段只安装生产依赖（`tsx` 已作为启动运行时依赖），以非 root 用户 `node`（UID 1000）运行，入口为 `node --import tsx src/server/launcher.ts`。
- 健康检查使用 `node -e fetch(.../api/health)`，只判断 HTTP 200，不输出业务细节；容器内应用端口固定 `8787`。

## 运行配置与标准部署

```powershell
cd deploy
Copy-Item .env.example .env
# 填写 ENCRYPTION_KEY、ALLOWED_HOSTS、ALLOWED_ORIGINS，
# 确认 DEPLOY_DATA_DIR / DEPLOY_KNOWLEDGE_DIR
```

正式发布从仓库根目录执行标准入口。脚本读取当前完整 Git commit，使用包版本和 commit 前 12 位生成镜像标签，执行质量门禁、构建、容器替换和运行版本核验：

```powershell
pwsh -File scripts/lan-deploy.ps1 `
  -EnvFile deploy/.env `
  -ContainerName customer-chat-analysis `
  -EntryUrl http://127.0.0.1:8787
```

- 正式发布要求工作区干净；`git push` 只会推送提交，不会重新构建镜像、替换运行容器或更新局域网入口。
- `-Preview` 只允许显式标记的非发布构建使用，不能作为真实局域网发布验收的替代。
- `-RollbackImage <tag>` 跳过构建并把应用切换到指定的旧镜像标签，例如：

  ```powershell
  pwsh -File scripts/lan-deploy.ps1 `
    -EnvFile deploy/.env `
    -ContainerName customer-chat-analysis `
    -EntryUrl http://127.0.0.1:8787 `
    -RollbackImage customer-chat-analysis-center:0.1.0-aaaaaaaaaaaa
  ```

- 脚本先记录当前运行镜像，再按健康检查、容器内 `npm run ready:check`、`/api/version` 和入口 HTML 资源顺序核验。`ready:check` 只读检查数据目录、SQLite 完整性、外键、当前迁移版本、关键表、磁盘空间和模型状态。健康、就绪、提交、镜像或 JS/CSS 资源任一核验失败时返回非零，并尝试恢复上一镜像。
- 成功输出应包含目标 commit、镜像标签、镜像 ID、运行时 JS/CSS 资源，以及可直接复制的回滚命令。`/api/version` 是无需登录的发布元数据接口，只返回版本、完整 commit SHA、构建时间、镜像标签和入口资源；不包含凭据、数据库或宿主机路径。
- `/api/ready` 继续要求管理员权限；部署脚本不保存管理员密码、会话 Cookie 或部署令牌，而是通过容器内的 `npm run ready:check` 获取同一就绪服务的退出码。

- **单实例**：`container_name: customer-chat-analysis` 固定容器名，`deploy.replicas: 1`，不可 `--scale app=2`；同一宿主机同一数据库只允许一个容器。启动入口的日志锁与端口占用会拒绝第二个实例。
- **端口**：本地开发服务默认使用 `http://localhost:8787`，Docker 局域网容器内部也固定监听 `0.0.0.0:8787`，但 Compose 只把它发布到宿主机 `127.0.0.1:${APP_PORT}`，再由内网反向代理 / TLS 终止器对外提供服务；不要让本地开发进程和局域网容器同时争用同一宿主机端口，也不要直接把应用端口暴露到局域网或公网。
- **持久化**：`DEPLOY_DATA_DIR` → `/app/data`（SQLite、上传、导出、日志、备份、`.secrets` 托管密钥），`DEPLOY_KNOWLEDGE_DIR` → `/app/knowledge`（知识快照）。两者必须在主机本地磁盘，不能放网络共享盘。
- **密钥**：`ENCRYPTION_KEY` 只存在于 `deploy/.env`（不提交、不打入镜像）。若不提供，应用会在 `DATA_DIR/.secrets/` 生成托管密钥文件，必须单独备份（见 [加密密钥管理](encryption-key-management.md)）。会话使用随机令牌，无需额外会话密钥；`SESSION_TTL_HOURS` 控制有效期，`SESSION_COOKIE_SECURE` 默认要求 HTTPS。
- **内部入口**：`ALLOWED_HOSTS` 与 `ALLOWED_ORIGINS` 必须填写反向代理对外的内网域名，否则应用的浏览器边界会拒绝代理转发的请求（见下节）。
- **资源限制**：`APP_MEMORY_LIMIT`（默认 `2g`）、`APP_CPU_LIMIT`（默认 `2.0`）。
- **日志**：应用写 `DATA_DIR/logs`（按大小/日期轮换），Compose 同时用 `json-file` 驱动保留最近 7 个 10 MiB 日志。

## 内部 HTTPS 与网段限制

应用本身不监听公网、不签发证书；TLS 由部署在应用同一台主机上的反向代理终止：

```text
局域网浏览器 ── https://chat.example.lan ──▶ 反向代理（443，内网 CA 证书）
                                              └─▶ 127.0.0.1:8787 应用容器
```

- **代理位置**：宿主机级反向代理（nginx / Caddy / 组织批准的 TLS 终止器），与应用容器同一台机器；示例配置见 `deploy/reverse-proxy.example.conf`（nginx，含 HTTP→HTTPS 跳转、TLS 1.2/1.3、大文件超时与 `Host` 保留）。
- **证书来源**：组织内网 CA 签发，或自签名证书由内网客户端的受信任根导入。证书与私钥保存在宿主机受保护目录（仅代理进程账户可读），不进入仓库、镜像或 CI。不要为内部服务使用公网 CA 自动化。
- **应用侧配置**：`.env` 中 `ALLOWED_HOSTS=chat.example.lan`、`ALLOWED_ORIGINS=https://chat.example.lan`，与应用地址完全一致；代理必须保留 `Host`，否则应用会以 403 拒绝。若临时使用无 TLS 环境，才可把 `SESSION_COOKIE_SECURE=false`。
- **允许的网段**：只在防火墙上放行批准的局域网网段访问代理端口。示例：
  - Windows 主机：`New-NetFirewallRule -DisplayName "客服解析中心内网入口" -Direction Inbound -Protocol TCP -LocalPort 443 -RemoteAddress 192.168.10.0/24 -Action Allow`（默认入站阻止负责其余来源）。
  - Linux/ufw：`sudo ufw allow from 192.168.10.0/24 to any port 443 proto tcp`。
- **禁止公网暴露**：不做路由器端口映射/DMZ，不配置公网 DNS，不把 `8787`、`443` 直接发布到公网。允许访问的客户端必须能解析并使用内网证书链。

### 本机最实用配置（Windows + Docker Desktop）

仓库提供了本机可复跑的 nginx 内网 HTTPS 入口。应用仍只发布到宿主机回环地址，
nginx 与应用在同一个 Compose 网络中，脚本使用本机生成的根 CA 签发
`LAN_HOSTNAME` 证书。首次配置请使用管理员 PowerShell：

```powershell
.\scripts\setup-local-lan-https.ps1 `
  -Hostname chat.customer.lan `
  -LanIp 172.16.20.178 `
  -ApplyFirewall `
  -Start `
  -InstallRoot
```

脚本会：

- 创建或更新 `deploy/.env`，设置 `ALLOWED_HOSTS`、`ALLOWED_ORIGINS` 和安全 Cookie；
- 启动应用与 nginx HTTPS 代理；
- 将本机根 CA 和服务器证书生成到 `deploy/proxy-data/tls/`，并安装根证书到当前 Windows 用户的信任根；
- 在本机 hosts 写入内网域名；
- 仅对 `LAN_ALLOWED_CIDR` 放行 80/443 入站。
- 将代理端口只绑定到指定的 `LanIp`，不监听 VMware、WSL 或其他本机接口。

默认使用 `8080/8443`，避免与本机其他服务占用标准 `80/443`；入口为
`https://chat.customer.lan:8443`。如果标准端口空闲，可以通过
`-HttpPort 80 -HttpsPort 443` 改用标准端口。

其他内网电脑需要复制 `deploy/proxy-data/tls/root-ca.cer`，
安装到受信任的根证书，并将 `chat.customer.lan` 解析到本机内网 IP。不要复制
`deploy/.env`、模型 API Key、数据库或整个 `proxy-data` 目录。面向普通使用者的
逐步配置、验收和故障排查见 [局域网其他电脑访问使用手册](lan-client-access.md)。

如果 Docker Desktop 尚未启动，先启动后再执行脚本。停止入口使用：

```powershell
docker compose --env-file deploy/.env `
  -f deploy/docker-compose.yml `
  -f deploy/docker-compose.lan-https.yml `
  down
```

## 可复跑验证

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify-lan-runtime.ps1
```

脚本执行：镜像构建 → 首次启动并等待健康 → 健康响应检查（无内部路径）→ 非 root 身份 → 数据库/托管密钥/知识快照生成 → 删除并重建容器验证数据仍在 → 同容器再次启动入口必须被拒绝 → Compose 配置校验。返回码 `0` 通过、`1` 失败、`2` 表示本机没有可用 Docker（跳过）。

真实内网环境的跨工作站现场验收使用 `scripts/verify-lan-acceptance.ps1 -ExternalEntry https://<内部域名>`：脚本校验真实证书、执行五角色权限矩阵并输出脱敏证据，完整步骤见 [局域网现场验收执行手册](lan-acceptance-runbook.md)。

## 升级与回滚

1. 升级前备份：`docker exec customer-chat-analysis npm run backup`，确认 `DATA_DIR/backups/full-*` 生成；托管密钥文件一并单独留存。
2. 使用上面的 `scripts/lan-deploy.ps1` 正式发布命令。不要手工修改镜像标签，也不要用裸 `docker compose up -d` 替代标准入口。
3. 发生核验失败时，脚本尝试恢复发布前记录的镜像；也可以使用 `-RollbackImage <tag>` 显式切换到已知旧镜像，并再次执行健康、就绪、版本和资源核验。
4. 镜像回滚只切换应用容器，不删除、不重建、不改写 `DEPLOY_DATA_DIR` 或 `DEPLOY_KNOWLEDGE_DIR` 中的持久数据。若新版本已经执行了不兼容的数据结构变更，不能只回滚镜像；必须按升级前备份和 [备份与恢复](backup-and-recovery.md) 指引恢复到独立目录，完成数据库完整性、密钥和业务数据校验后再切换。

## 没有 Docker 时的 Windows 服务等价契约

在固定 Windows 主机上以服务方式运行时，必须满足同等契约：

- 使用 `scripts/start-local.ps1`（或 `start-local.cmd`）作为唯一启动入口，由服务包装器（如 NSSM、任务计划程序）调用；不要直接运行 `src/server/index.ts` 绕过日志锁与日志轮换。
- 数据目录、数据库、日志、备份与密钥文件必须位于本机磁盘固定目录（`DATA_DIR`、`DATABASE_PATH`），不使用网络共享盘。
- 以专用低权限账户运行；`deploy/.env.example` 中的密钥与内网入口要求同样适用（`ENCRYPTION_KEY`、`ALLOWED_HOSTS`、`ALLOWED_ORIGINS`）。
- 健康检查对 `http://127.0.0.1:8787/api/health` 返回 200 视为存活；服务包装器需要配置自动重启与日志收集。
- TLS 由内网反向代理终止；Host/Origin 防护仍按 `docs/guides/local-access-and-startup.md` 生效。
- 限制：没有容器级的资源限额与只读根文件系统；升级回滚依赖文件快照而非镜像标签；跨容器锁不适用，必须保证单机单实例。
