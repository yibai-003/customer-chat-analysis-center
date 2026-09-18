# 06: 备份恢复、内部 HTTPS 与运维手册

**What to build:** 形成局域网运行的可恢复运维闭环：内部 HTTPS 接入、网段限制、备份与密钥保管、独立位置恢复演练、升级回滚和日志收集。

**Blocked by:** 04: 局域网镜像与单实例运行单元

**Status:** done (2026-09-17)

- [x] 部署说明明确内部 TLS 终结或反向代理位置、证书来源、允许的局域网网段、应用端口和禁止公网暴露的边界。
- [x] 备份覆盖 SQLite 数据库、上传源文件、提取图片、导出文件、知识快照、配置和独立受保护的加密密钥材料；备份不依赖镜像层。
- [x] 恢复流程始终恢复到独立目录并验证数据库、文件引用、知识配置和密钥可用性，再允许替换运行数据。
- [x] 发布前完成一次容器化运行的备份与独立恢复演练，并记录恢复时间、验证结果和残留风险。
- [x] 运行手册包含首次部署、管理员初始化、密钥更新、日志收集、存储空间检查、升级前备份、镜像版本回滚和故障处置。
- [x] 备份、恢复和运维管理动作在具备认证后只允许管理员执行，并可在审计中追溯。

**实现摘要（2026-09-17）：**
- **内部 HTTPS 接入（代码）**：新增 `LISTEN_HOST`（容器内 `0.0.0.0`，默认仍 `127.0.0.1`）与 `ALLOWED_HOSTS` / `ALLOWED_ORIGINS`；`localAccess` 在保留本机/Vite 校验的同时接受配置的内网 Host 与精确 Origin，其余仍 403；`deploy/docker-compose.yml`、`deploy/.env.example` 清理过期 `SESSION_SECRET`，补 `SESSION_TTL_HOURS` / `SESSION_COOKIE_SECURE` 与入口变量；`scripts/verify-lan-runtime.ps1` 同步更新并通过。
- **部署说明**：`docs/guides/lan-deployment.md` 新增“内部 HTTPS 与网段限制”章节（代理位置、内网 CA 证书来源、`ALLOWED_HOSTS`/`ALLOWED_ORIGINS`、Windows/ufw 网段放行示例、禁止公网映射/DMZ/公网 DNS），并附 `deploy/reverse-proxy.example.conf`（nginx TLS 1.2/1.3、Host 保留、大文件超时）。
- **备份覆盖**：`createFullBackup` 增加 `exportsDir`，完整包现在包含 `DATA_DIR/exports` 导出结果并带 SHA-256；数据库、上传源文件、图片、知识导入、知识快照与数据库内配置沿用原有引用清单；加密密钥按“独立受保护材料”流程单独保管（不进入包内）。
- **恢复校验**：新增 `src/server/services/restore-verification.ts` 与 `npm run restore:verify -- <恢复目录>`，校验 `RESTORED.json`、数据库完整性/外键/版本、数据库引用文件、知识快照哈希、模型凭据密钥可用性；`restore` 仍只写独立目录，失败保留 `RESTORE_FAILED.txt`；文档补充校验与切换步骤（`backup-and-recovery.md`、`encryption-key-management.md`）。
- **容器化演练**：新增 `scripts/verify-backup-restore.ps1`（构建镜像→启动→写入含图片引用的数据→备份→恢复到独立目录→放置托管密钥→`restore:verify`），本机实测通过：备份 3.8s（3 文件/2 引用）、恢复 1.6s、校验 0.6s、5 项检查全绿；记录见 `docs/archive/lan-backup-restore-drill-2026-09-17.md`（含残留风险）。
- **运维手册**：新增 `docs/guides/lan-operations.md`，覆盖首次部署、管理员初始化（容器内 CLI/一次性环境变量/账号接口示例）、密钥管理、备份、恢复演练与切换、升级、镜像回滚、日志收集、存储检查、故障速查与审计追溯；索引更新到 `docs/README.md`。
- **管理员专属与审计**：备份/恢复 HTTP 入口（`backup:manage`）与账号管理（`user:manage`）仅管理员可用并写 `backup.create`/`backup.restore`/`identity.*` 审计，审计查询仅 `audit:view`；由 Issue 03 的集成测试与不可变审计触发器保证，本单元文档明确操作路径。

