# 局域网现场验收执行手册

本手册对应 Issue 11：在固定运行主机、真实内网证书/DNS/防火墙和另一台物理工作站上完成跨机验收。机器可自动化的部分由 `scripts/verify-lan-acceptance.ps1` 完成；主机侧与浏览器侧步骤由现场人员按本文执行并留存脱敏证据。

## 前置条件

- 固定运行主机：主机本地 SSD，固定内网地址，已安装 Docker（或按 [局域网部署](lan-deployment.md) 的 Windows 服务等价契约），数据卷位于本机磁盘而非网络共享盘。
- 组织内网 CA 可签发证书；内网 DNS 可新增正式内部域名（例如 `chat.example.lan`）。
- 另一台真实局域网工作站（Windows，Node.js 22.12+，仓库工作副本可用）。
- 镜像：使用 Issue 10 记录中通过 CI 的镜像标签与 ID（见 [发布验收记录](../archive/lan-release-acceptance-2026-09-17.md) 的“首次真实 CI 与发布工件”）。

## 步骤 1：主机与持久卷（Issue 11-1）

在固定主机执行并记录：

```powershell
Get-CimInstance Win32_ComputerSystem | Select-Object Name, TotalPhysicalMemory
Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors
Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" | Select-Object DeviceID, Size, FreeSpace
docker version --format "{{.Server.Version}}"
```

记录：操作系统版本、CPU、内存、系统盘与数据盘、`DEPLOY_DATA_DIR` / `DEPLOY_KNOWLEDGE_DIR` 的绝对路径、镜像 `APP_IMAGE` 标签与 ID。

## 步骤 2：内网 CA 证书与 DNS（Issue 11-2）

1. 由组织内网 CA 为正式内部域名签发服务器证书（含该域名的 SAN），私钥仅存放在主机受保护目录。
2. 将证书与私钥挂载到 TLS 终止器（示例见 `deploy/reverse-proxy.example.conf`），代理必须保留原始 `Host`。
3. 在内网 DNS 添加 A 记录指向固定主机：
   ```powershell
   Resolve-DnsName -Name <内部域名> -Type A
   ```
4. 在工作站浏览器确认证书链受信（颁发者应为组织内网 CA，而非自签名）。

最终验收证据不得使用自签名证书或虚构域名。

## 步骤 3：部署已通过 CI 的镜像（Issue 11-1/3）

在主机 `deploy/` 下：

```powershell
Copy-Item .env.example .env
# APP_IMAGE=<Issue 10 记录中的镜像标签>
# ENCRYPTION_KEY=<独立强密钥，另行受保护备份>
# ALLOWED_HOSTS=<内部域名>
# ALLOWED_ORIGINS=https://<内部域名>        # 与浏览器地址完全一致
# SESSION_COOKIE_SECURE=true
# DEPLOY_DATA_DIR / DEPLOY_KNOWLEDGE_DIR=<本机绝对路径>
docker compose up -d
```

首次启动通过 `FIRST_ADMIN_USERNAME` / `FIRST_ADMIN_PASSWORD` 环境变量或主机本地 `npm run bootstrap:admin` 创建管理员；随后删除密码配置。

## 步骤 4：防火墙与网络边界（Issue 11-4）

只允许批准的局域网网段访问 HTTPS 入口，应用容器端口仅发布到 `127.0.0.1`：

```powershell
# Windows 主机示例
New-NetFirewallRule -DisplayName "客服解析中心内网入口" -Direction Inbound -Protocol TCP -LocalPort 443 -RemoteAddress <批准网段>/24 -Action Allow
Get-NetFirewallRule -DisplayName "客服解析中心内网入口" | Get-NetFirewallAddressFilter
# 确认没有公网映射
Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 443,8787
docker compose -f deploy/docker-compose.yml port app 8787
```

```bash
# Linux 主机示例
sudo ufw allow from <批准网段>/24 to any port 443 proto tcp
sudo ss -tlnp | grep -E ':(443|8787)'
```

确认路由器未做端口映射/DMZ、未配置公网 DNS。

## 步骤 5：跨机自动验收（Issue 11-5/6/8）

在另一台真实工作站上执行（最终证据必须 TLS 校验开启，不要加 `-AllowSelfSigned`；真实模型凭据必须提供并加 `-RequireRealModel`）：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-lan-acceptance.ps1 `
  -ExternalEntry "https://<内部域名>" `
  -AdminPassword "<验收管理员密码>" `
  -RequireRealModel `
  -ModelBaseUrl "https://<模型网关>/v1" `
  -ModelApiKey "<真实 API Key>" `
  -ModelName "<视觉模型名>" `
  -TextModelName "<文本模型名>" `
  -EvidencePath ".\lan-field-evidence.json"
```

API Key 也可以通过环境变量 `ACCEPTANCE_MODEL_API_KEY` 等传入，避免进入命令历史；脚本只在创建模型配置的请求体中使用它，证据文件与日志不会写入密钥。

脚本自动完成：

- 内网 DNS 解析检查；
- 真实证书校验（`ACCEPTANCE_TLS_VERIFY=true`）并记录证书主体、颁发者、有效期与 SHA-256 指纹；
- 五类角色登录与完整权限矩阵（读取、导入、解析、复核、导出、配置、模型池、账号、审计、备份），越权必须 403；
- 共享任务/记录/图片读取、匿名拒绝；
- 真实模型闭环：创建并验证视觉/文本模型、设为默认、连通性与能力检测（文本/JSON/视觉）、导入脱敏 Excel、执行一次真实模型解析并断言模型输出与用量事件，全程校验响应/审计/用量不泄漏 API Key；
- 审计不泄漏凭据、关联 ID 贯通、备份 API 创建成功。

### 5.1 用桩模型预演（可选，不作为签署证据）

正式提交真实 Key 前，可在工作站本地启动桩模型预热流程，确认脚本、防火墙与容器到主机的网络通路正常：

```powershell
node scripts/lan-acceptance-stub-model.mjs   # 监听 0.0.0.0:8788
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-lan-acceptance.ps1 `
  -ExternalEntry "https://<内部域名>" -RequireRealModel `
  -ModelBaseUrl "http://host.docker.internal:8788/v1" `
  -ModelApiKey "stub-model-secret" -ModelName "stub-vision" -TextModelName "stub-text"
```

桩模型只返回固定的探测值与占位解析结果，**不得**用于最终签署；正式证据必须使用真实模型供应商。

浏览器侧人工抽查（同机）：

1. 打开 `https://<内部域名>`，确认地址栏证书受信、页面无告警；
2. 管理员登录 → 退出 → 用另一浏览器会话确认旧会话已失效；
3. 打开一条记录图片，确认原图可查看；
4. 用另一个账号确认共享任务/记录可读取；
5. 抽查五类角色入口显隐，并确认越权操作返回服务端拒绝；
6. 在配置界面重新检测一次真实视觉/文本模型，确认能力检测通过且列表只显示掩码后的 Key。

## 步骤 6：主机侧容器检查（Issue 11-7）

在固定主机执行：

```powershell
# 重启持久化
docker restart customer-chat-analysis
docker exec customer-chat-analysis sh -c "test -f /app/data/app.db && test -f /app/data/.secrets/app.db.key.json"

# 单实例保护（应失败并提示已有服务）
docker exec customer-chat-analysis node --import tsx src/server/launcher.ts

# 备份与独立恢复校验（见 Issue 06 演练）
docker exec customer-chat-analysis npm run backup
docker exec customer-chat-analysis npm run restore -- /app/data/backups/<备份目录> --to /tmp/field-restore
docker exec customer-chat-analysis sh -c "mkdir -p /tmp/field-restore/data/.secrets && cp /app/data/.secrets/app.db.key.json /tmp/field-restore/data/.secrets/"
docker exec customer-chat-analysis npm run restore:verify -- /tmp/field-restore
```

重启后重新登录核对：账号、任务、上传文件、图片、知识配置、模型凭据、日志和审计数据仍可用。

## 步骤 7：证据归档与脱敏（Issue 11-8）

保存以下脱敏证据：

| 证据 | 形式 | 脱敏要求 |
| --- | --- | --- |
| 主机规格与卷路径 | 文本表格 | 可保留设备名，隐去无关主机信息 |
| 证书 | 主体/颁发者/有效期/SHA-256 指纹 | 不含私钥与证书文件本身 |
| DNS | 解析记录截图或命令输出 | 仅保留内部域名与解析结果 |
| 防火墙 | 规则命令输出 | 网段可写成批准范围，不必暴露全部内网结构 |
| 跨机验收 | `lan-field-evidence.json` | 脚本已排除密码/会话/API Key |
| 服务端拒绝 | 脚本步骤结果或浏览器截图 | 截图需遮盖个人信息 |
| 重启/单实例/恢复 | 命令输出 | 不含密钥内容 |

任何证据不得包含：密码、会话 Cookie、API Key、加密密钥、私钥、完整业务数据文件。

更新 [发布验收记录](../archive/lan-release-acceptance-2026-09-17.md) 中“真实第二台工作站”与基础设施待办，并回填 Issue 11、Issue 12 检查项。

## 通过标准

- 步骤 5 输出 `FIELD ACCEPTANCE OK`，证据中 `tlsVerified: true` 且 `realModel.configured: true`、`acceptance.modelEvidence` 至少记录一次真实模型调用成功；
- 浏览器侧抽查全部通过，越权请求均被服务端拒绝；
- 步骤 6 重启后数据可用且第二实例被拒绝，`restore:verify` 全部通过；
- 证据齐全且脱敏。

任一环节失败时保留现场证据、修复后重新执行对应步骤；不以本机自签名演练结果替代现场验收。
