# 局域网运维手册

本手册对应 `.scratch/lan-single-organization-upgrade/issues/06-backup-restore-tls-and-operations.md`，是固定局域网主机上的日常运行入口。部署细节见 [局域网部署与单实例运行](lan-deployment.md)，本文只给操作步骤与判断标准。

所有命令默认在宿主机、仓库根目录或 `deploy/` 执行；容器命令使用固定容器名 `customer-chat-analysis`。备份、恢复与账号管理只允许管理员，操作会自动写入审计（见最后一节）。

## 1. 首次部署

1. 准备固定主机：本机磁盘、固定内网地址、可用 Docker（无 Docker 时按 [局域网部署](lan-deployment.md) 的 Windows 服务等价契约）。
2. 配置环境：`cd deploy; Copy-Item .env.example .env`，填写 `APP_IMAGE`、`ENCRYPTION_KEY`（独立强密钥）、`ALLOWED_HOSTS`、`ALLOWED_ORIGINS`，确认 `DEPLOY_DATA_DIR`、`DEPLOY_KNOWLEDGE_DIR` 在本地磁盘。
3. 部署 TLS：按 `deploy/reverse-proxy.example.conf` 配置内网反向代理；证书由内网 CA 签发或自签名并导入客户端信任；只放行批准网段，不映射公网。
4. 启动：`docker compose up -d --build`，等待健康检查通过；首次启动自动生成数据库、托管密钥（`.secrets/app.db.key.json`）与知识快照。
5. 可复跑验证：`pwsh -File scripts/verify-lan-runtime.ps1` 应返回 `PASS`（镜像、健康、非 root、持久化重建、单实例保护、Compose 校验）。

## 2. 管理员初始化

首次部署后没有账号，登录页会提示运行引导命令。二选一，均只能生效一次：

```powershell
# 方式 A：主机本地命令（推荐）
docker exec customer-chat-analysis npm run bootstrap:admin -- --username admin --password "至少8位的初始密码"

# 方式 B：首次启动前在 deploy/.env 填写一次性环境变量（见 deploy/.env.example）
FIRST_ADMIN_USERNAME=admin
FIRST_ADMIN_PASSWORD=至少8位的初始密码
# FIRST_ADMIN_DISPLAY_NAME=管理员
```

方式 B 在首次成功登录后必须删除密码行并重启容器；非容器部署把同样两项写入项目根目录 `.env`。账号存在后该入口自动失效。

完成后立即登录并按需在“账号管理”接口创建其他账号；账号由管理员创建、停用和重置，不开放自助注册。会话 Cookie 为 `HttpOnly + SameSite=Lax + Secure`；停用、重置密码、登出或到期都会即时撤销会话。

如果管理员密码遗失或当前密码无法登录，先停止应用容器，再在主机上使用实际运行镜像执行本地重置。该命令只允许重置已存在的管理员账号：

```powershell
docker stop customer-chat-analysis
$env:ADMIN_PASSWORD = "新的临时密码"
docker run --rm `
  -e ADMIN_PASSWORD `
  -v "${PWD}:/app" `
  -v "本机数据目录:/app/data" `
  customer-chat-analysis:lan `
  npm run reset:admin -- --username admin
Remove-Item Env:ADMIN_PASSWORD
docker start customer-chat-analysis
```

生产环境应使用当前实际运行镜像和实际数据目录，不要把密码写入 Git、镜像或长期环境变量；登录成功后立即按组织密码策略更换并清理临时凭据。

账号管理（管理员会话下，PowerShell 示例）：

```powershell
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod -Uri https://chat.example.lan/api/auth/login -Method Post -WebSession $session `
  -ContentType "application/json" -Body '{"username":"admin","password":"初始密码"}'
Invoke-RestMethod -Uri https://chat.example.lan/api/admin/users -Method Post -WebSession $session `
  -ContentType "application/json" -Body '{"username":"zhang","password":"初始密码","displayName":"张三","role":"operator"}'
Invoke-RestMethod -Uri https://chat.example.lan/api/admin/users/<id> -Method Patch -WebSession $session `
  -ContentType "application/json" -Body '{"isEnabled":false}'
Invoke-RestMethod -Uri https://chat.example.lan/api/admin/users/<id>/reset-password -Method Post -WebSession $session `
  -ContentType "application/json" -Body '{"password":"新的初始密码"}'
```

角色与权限：管理员 / 配置人员 / 操作人员 / 审核人员 / 只读人员，矩阵见 [ADR-0001](../adr/0001-lan-single-organization-access-model.md) 与 [局域网访问模型](lan-deployment.md)。

## 3. 密钥管理

- 新安装自动生成托管密钥 `DATA_DIR/.secrets/app.db.key.json`；设置 `ENCRYPTION_KEY` 时以环境密钥为准。不要在两个环境复用同一个密钥，不要提交到 Git。
- 旧默认密钥迁移见 [加密密钥管理与迁移](encryption-key-management.md)（`npm run keys:migrate -- --status/--apply`）。当前版本不提供任意自定义密钥轮换；更换密钥需要“新库 + 重新录入模型凭据”或按迁移流程处理。
- 密钥必须单独备份：复制 `.secrets/app.db.key.json` 到受保护位置，限制 ACL（仅运维账户与 SYSTEM），记录 SHA-256 及其对应的数据库/备份批次。完整备份包刻意不含密钥。
- 恢复或换机后先验证密钥可用：`npm run restore:verify -- <恢复目录>` 会检查模型凭据能否用当前密钥解密。

## 4. 备份

- 手动备份：`docker exec customer-chat-analysis npm run backup`（或管理员接口 `POST /api/admin/backups`，也可在页面“备份管理”中创建）。输出目录 `DATA_DIR/backups/full-<时间>-<标识>/`。
- 自动备份：服务启动时按 `BACKUP_INTERVAL_HOURS`（默认 24h）调度，分析/导入进行中会延后；保留最近 `BACKUP_RETENTION` 个已验证包。
- 备份内容：SQLite 在线快照、原始 Excel、截图、知识导入文件、`DATA_DIR/exports` 下的导出结果、知识快照 JSON、数据库内的板块/字段/模型/知识配置；每个文件带大小与 SHA-256。**加密密钥不在包内**，按第 3 节单独保管。
- 备份不依赖镜像层：数据全部来自 `DATA_DIR` 与 `KNOWLEDGE_DIR` 挂载卷，重建容器或删除镜像不影响备份。
- 升级前必须备份；重要变更前先暂停分析与导入，避免备份时源文件变动。

## 5. 恢复演练与切换

恢复始终写入**新目录**，不覆盖运行环境：

```powershell
# 1) 恢复到一个尚不存在的独立目录（容器内或本机 CLI 均可）
docker exec customer-chat-analysis npm run restore -- /app/data/backups/full-<时间>-<标识> --to /tmp/recovery-20260917

# 2) 放入匹配的密钥后校验：数据库版本/完整性、文件引用、知识哈希、密钥可用性
docker exec customer-chat-analysis sh -c "mkdir -p /tmp/recovery-20260917/data/.secrets && cp /app/data/.secrets/app.db.key.json /tmp/recovery-20260917/data/.secrets/"
docker exec customer-chat-analysis npm run restore:verify -- /tmp/recovery-20260917
```

`restore:verify` 必须全部 `ok: true` 且退出码 0 才可进入切换：先启动一个使用恢复目录的临时实例检查页面、原图、知识检索与导出，通过后停止原服务，把 `DEPLOY_DATA_DIR` 指向恢复目录（或替换目录内容）再启动；失败则停用恢复环境，回到原目录。恢复时间、校验结果与残留风险的记录模板见 [容器化备份与独立恢复演练（2026-09-17）](../archive/lan-backup-restore-drill-2026-09-17.md)。

## 6. 升级

1. 记录当前镜像标签：`deploy/.env` 的 `APP_IMAGE`。
2. 升级前备份并用 `npm run restore --verify <备份目录>`（或 `restore:verify`）确认包可用；密钥单独留存。
3. 低峰期构建新镜像并打新标签，修改 `APP_IMAGE` 后 `docker compose up -d`；等待健康检查通过再放开代理。
4. 数据库迁移在启动时自动执行并留有迁移前保护备份；迁移失败会拒绝启动，按报错恢复旧镜像与备份。

## 7. 回滚

- 代码/镜像回滚：把 `APP_IMAGE` 改回上一标签，`docker compose up -d`，验证健康与关键页面。
- 数据结构不兼容时：停止服务，按第 5 节把升级前备份恢复到独立目录并校验，确认后再切换数据目录。
- 不要用旧镜像直接打开已升级的新数据库结构；也不要只回滚数据而保留不兼容镜像。

## 8. 日志收集

- 应用日志：`DATA_DIR/logs/server.out.log` 等按大小与日期轮换；Compose 额外保留最近 7 个 10 MiB 的 `docker logs`。
- 排障：`docker logs --since 2h customer-chat-analysis`；提交问题前收集最近日志、时间范围、操作人、页面与请求路径。
- 日志与审计不包含密码、会话令牌、API Key 明文；不要把 `deploy/.env`、`.secrets/` 或业务数据放入日志包。

## 9. 存储空间检查

- 启动与就绪检查要求 `DATA_DIR` 可用空间不低于 `MIN_FREE_DISK_MB`（默认 512 MB）；管理员访问 `/api/ready` 查看数据库、磁盘与模型状态。
- 定期检查：`df`/磁盘属性；`DATA_DIR`（数据库、上传、导出、日志、备份）与 `KNOWLEDGE_DIR`。
- 清理：`npm run maintenance -- --dry-run` 预览、`--apply` 执行过期临时文件清理；备份按 `BACKUP_RETENTION` 自动轮换，导出文件会随完整备份保存，可按需手动归档。

## 10. 故障处置速查

| 现象 | 判断与处置 |
| --- | --- |
| 启动报“已有服务运行/端口占用” | 同一数据库只允许一个实例；确认是否有旧容器或进程占用，先停止再启动 |
| 启动报数据库版本不匹配 | 用匹配版本的镜像；需要降级时按第 5 节恢复旧备份到独立目录 |
| 模型凭据无法解密 | 密钥文件缺失或不匹配；放入对应的 `.secrets/app.db.key.json` 或原 `ENCRYPTION_KEY`，不要删除数据库 |
| 登录返回 403 且直接访问跳转正常 | 反向代理未保留 `Host`，或 `ALLOWED_HOSTS`/`ALLOWED_ORIGINS` 与实际地址不一致 |
| 登录会话立即失效 | 检查时钟、Cookie 是否被代理改写；HTTPS 环境保持 `SESSION_COOKIE_SECURE=true` |
| 备份失败/卡住 | 查看 `DATA_DIR/backups/.backup.lock` 是否残留（确认无备份进程后手动移走）；确认磁盘空间与源文件未变动 |
| 恢复目录出现 `RESTORE_FAILED.txt` | 该目录不可启动；换新目录重试，原环境不受影响 |
| 解析任务长时间无进展 | 查看任务队列与 `/api/ready` 模型状态、日志中的供应商错误，必要时暂停后重试失败记录 |

## 11. 审计与追溯

- 管理员查询：`GET /api/admin/audit-events?action=&actorUserId=&targetType=&targetId=&outcome=&from=&to=&limit=`；也可在页面“审计日志”中按动作、操作者、目标、结果与时间范围筛选并逐页加载。
- 审计覆盖：登录成败、登出、账号增改/停用/重置、配置与知识库变更、模型池操作、导入、解析生命周期、复核、导出、备份与恢复，以及所有权限拒绝。
- 审计事件为追加写入，存储层拒绝修改与删除；包含操作者、动作、目标、结果、时间与请求关联标识（`x-request-id`），不保存密码、会话与 API Key。
- 审计仅管理员可查；日常追溯按时间范围与动作过滤，导出结论时保留原始时间与 ID。
