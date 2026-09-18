# 局域网部署与单实例运行

本指南对应 `.scratch/lan-single-organization-upgrade/issues/04-lan-image-and-single-instance-runtime.md`：把应用封装为可在固定局域网主机运行的生产镜像和声明式运行配置。账号、权限与审计属于后续单元；本单元只管运行层。

## 镜像契约

- `Dockerfile` 多阶段构建：固定基础镜像 `node:22.23.2-bookworm-slim`；`npm ci` 按锁文件安装（原生模块缺失预编译时在容器内编译）；`npm run build` 产出前端资源。
- 运行阶段只安装生产依赖（`tsx` 已作为启动运行时依赖），以非 root 用户 `node`（UID 1000）运行，入口为 `node --import tsx src/server/launcher.ts`。
- 健康检查使用 `node -e fetch(.../api/health)`，只判断 HTTP 200，不输出业务细节；容器内应用端口固定 `8787`。

## 运行配置

```powershell
cd deploy
Copy-Item .env.example .env
# 填写 APP_IMAGE、ENCRYPTION_KEY、ALLOWED_HOSTS、ALLOWED_ORIGINS，
# 确认 DEPLOY_DATA_DIR / DEPLOY_KNOWLEDGE_DIR
docker compose up -d --build
```

- **单实例**：`container_name: customer-chat-analysis` 固定容器名，`deploy.replicas: 1`，不可 `--scale app=2`；同一宿主机同一数据库只允许一个容器。启动入口的日志锁与端口占用会拒绝第二个实例。
- **端口**：应用在容器内监听 `0.0.0.0:8787`（`LISTEN_HOST`），Compose 只把端口发布到宿主机 `127.0.0.1:${APP_PORT}`，由内网反向代理 / TLS 终止器对外提供服务；不要直接把应用端口暴露到局域网或公网。
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

## 可复跑验证

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify-lan-runtime.ps1
```

脚本执行：镜像构建 → 首次启动并等待健康 → 健康响应检查（无内部路径）→ 非 root 身份 → 数据库/托管密钥/知识快照生成 → 删除并重建容器验证数据仍在 → 同容器再次启动入口必须被拒绝 → Compose 配置校验。返回码 `0` 通过、`1` 失败、`2` 表示本机没有可用 Docker（跳过）。

## 升级与回滚

1. 构建并打标签：`docker build -t customer-chat-analysis:lan-<日期> .`，同时更新 `deploy/.env` 的 `APP_IMAGE`。
2. 升级前备份：`docker exec customer-chat-analysis npm run backup`，确认 `DATA_DIR/backups/full-*` 生成；托管密钥文件一并单独留存。
3. `docker compose up -d` 完成替换；健康检查通过后再放开代理。
4. 回滚：把 `APP_IMAGE` 改回上一标签并 `docker compose up -d`；如数据结构不兼容，使用升级前备份按 `docs/guides/backup-and-recovery.md` 恢复到独立目录。

## 没有 Docker 时的 Windows 服务等价契约

在固定 Windows 主机上以服务方式运行时，必须满足同等契约：

- 使用 `scripts/start-local.ps1`（或 `start-local.cmd`）作为唯一启动入口，由服务包装器（如 NSSM、任务计划程序）调用；不要直接运行 `src/server/index.ts` 绕过日志锁与日志轮换。
- 数据目录、数据库、日志、备份与密钥文件必须位于本机磁盘固定目录（`DATA_DIR`、`DATABASE_PATH`），不使用网络共享盘。
- 以专用低权限账户运行；`deploy/.env.example` 中的密钥与内网入口要求同样适用（`ENCRYPTION_KEY`、`ALLOWED_HOSTS`、`ALLOWED_ORIGINS`）。
- 健康检查对 `http://127.0.0.1:8787/api/health` 返回 200 视为存活；服务包装器需要配置自动重启与日志收集。
- TLS 由内网反向代理终止；Host/Origin 防护仍按 `docs/guides/local-access-and-startup.md` 生效。
- 限制：没有容器级的资源限额与只读根文件系统；升级回滚依赖文件快照而非镜像标签；跨容器锁不适用，必须保证单机单实例。
