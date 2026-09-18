# 04: 局域网镜像与单实例运行单元

**What to build:** 将应用封装为可在固定局域网主机运行的生产镜像和声明式运行配置，保证单实例、主机本地持久化、健康检查、非 root 运行和可配置网络入口。

**Blocked by:** None (can start immediately)

**Status:** done (2026-09-17)

- [x] 生产镜像使用受支持且固定版本的 Node 22 基础镜像，通过可复现依赖安装构建前端资源，并以非 root 用户运行应用。
- [x] Compose 或等价运行配置只启动一个应用实例，并把数据库、`DATA_DIR`、日志、备份和密钥文件映射到主机本地持久目录，而不是镜像层或网络共享盘。
- [x] 环境模板不含真实密钥，明确要求会话密钥、加密密钥、数据目录、端口、内部基础地址和资源限制。
- [x] 容器健康检查使用不泄漏业务细节的健康端点；重建容器后数据库、上传文件、导出、日志和密钥材料仍在受控持久目录中。
- [x] 启动配置保留并验证现有单实例锁，不允许两个进程同时写同一个 SQLite 数据库。
- [x] 自动化或可复跑脚本验证镜像构建、容器启动、健康检查、非 root 身份和持久卷重建；若目标主机没有 Docker，文档明确 Windows 服务等价运行的契约与限制。

**验证证据（2026-09-17）**

- `scripts/verify-lan-runtime.ps1` 退出码 0：镜像构建（`node:22.23.2-bookworm-slim`）、健康检查、非 root（UID 非 0）、首次落盘（app.db、`.secrets/app.db.key.json`、`knowledge/catalog.json`）、重建容器后标记/数据库/密钥/日志/知识快照仍在、同容器二次启动入口被拒绝（单实例锁）、`docker compose config` 校验通过。
- 交付物：`Dockerfile`、`deploy/docker-compose.yml`、`deploy/.env.example`、`docs/guides/lan-deployment.md`；`tsx` 调整为运行时依赖以支持生产安装。
- 内部基础地址由内网反向代理/TLS 终止器承担（端口仅绑定 `127.0.0.1`），代理与证书属于后续单元。

