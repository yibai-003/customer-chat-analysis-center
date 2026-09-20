# 局域网现场验收执行手册

本手册对应 Issue 11：在固定运行主机、真实内网证书/DNS/防火墙和另一台物理工作站上完成跨机验收。机器可自动化的部分由 `scripts/verify-lan-acceptance.ps1` 完成；主机侧与浏览器侧步骤由现场人员按本文执行并留存脱敏证据。

模型供应商凭据边界见 [ADR-0002：模型供应商凭据集中保存在运行主机](../adr/0002-centralized-model-provider-credentials.md)。

## 前置条件

- 固定运行主机：主机本地 SSD，固定内网地址，已安装 Docker（或按 [局域网部署](lan-deployment.md) 的 Windows 服务等价契约），数据卷位于本机磁盘而非网络共享盘。
- 组织内网 CA 可签发证书；内网 DNS 可新增正式内部域名（例如 `chat.example.lan`）。
- 另一台真实局域网工作站（Windows，Node.js 22.12+，仓库工作副本可用）。
- 镜像：使用 Issue 10 记录中通过 CI 的镜像标签与 ID（见 [发布验收记录](../archive/lan-release-acceptance-2026-09-17.md) 的“首次真实 CI 与发布工件”）。
- 脱敏但有代表性的正式样本：20–50 条记录，覆盖当前启用板块需要的原始字段；10 条演示样本只能用于预演。
- 已在系统中预先配置并审批真实模型供应商；正式验收传入的供应商名称和 HTTPS 地址必须与系统配置一致。

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

## 步骤 5：生成固定主机证据（Issue 11-1/7/8）

在固定主机上，针对正式运行容器执行：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/collect-lan-host-evidence.ps1 `
  -ContainerName "customer-chat-analysis" `
  -ExpectedImage "customer-chat-analysis:<批准版本标签>" `
  -ExpectedImageId "sha256:<批准镜像ID>" `
  -EntryHost "<内部域名>" `
  -EntryAddress "<固定主机内网IP>" `
  -EvidencePath ".\lan-host-evidence.json"
```

脚本会直接检查正式容器使用批准镜像和 `always`/`unless-stopped` 重启策略，且 `/app/data`、`/app/knowledge` 都是非临时、非网络共享的可写 `bind` 挂载；随后创建完整备份并恢复到独立目录，复制匹配的托管密钥执行 `restore:verify`，重启正式容器验证数据仍可用，并确认第二实例被单实例锁拒绝。输出的 `schemaVersion` 必须为 `2`、`mode` 必须为 `host-signoff` 且 `productionReady: true`。

`ExpectedImageId` 必须填写批准发布工件对应的不可变镜像摘要，不能只填写标签。摘要应从 CI 发布清单或 `docker inspect <container> --format "{{.Image}}"` 取得；脚本会比较运行中容器的实际摘要，防止标签被重新指向其他镜像。

主机证据有效期为 24 小时。跨机签收会重新校验证据中的主机名、入口域名/IP、镜像标签和镜像 ID，并自动确认采集主机与签收工作站不是同一台电脑；临时目录、Docker named volume、过期证据和手工声明跨机均不能通过。

## 步骤 6：跨机自动验收（Issue 11-5/6/8、Issue 12）

在另一台真实工作站上执行。最终证据必须 TLS 校验开启，不要加 `-AllowSelfSigned` 或 `-SkipDnsCheck`：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-lan-acceptance.ps1 `
  -ExternalEntry "https://<内部域名>" `
  -AdminPassword "<验收管理员密码>" `
  -Signoff `
  -RequireRealModel `
  -HostEvidencePath ".\lan-host-evidence.json" `
  -ExpectedHostImage "customer-chat-analysis:<批准版本标签>" `
  -ExpectedHostImageId "sha256:<批准镜像ID>" `
  -SamplePath ".\正式验收样本-20到50条.xlsx" `
  -ModelProvider "<系统中已审批的供应商名称>" `
  -ModelBaseUrl "https://<模型网关>/v1" `
  -ModelName "<视觉模型名>" `
  -TextModelName "<文本模型名>" `
  -EvidencePath ".\lan-field-evidence.json"
```

正式签收不接受也不需要在第二台工作站传入 API Key。管理员应先在主电脑的模型供应商配置中保存凭据；跨机脚本只按供应商名称和地址引用主电脑上的供应商，并由主电脑完成真实模型调用。`-ModelApiKey` 仅保留给桩模型或隔离预演使用。

正式模式在任何业务写入前检查可信 TLS、DNS、由主机证据自动证明的第二物理工作站、24 小时内的 `host-signoff` 证据、指定批准镜像、20–50 条样本要求以及非本机/非私网的 HTTPS 模型供应商地址。脚本自动完成：

- 内网 DNS 解析检查；
- 真实证书校验（`ACCEPTANCE_TLS_VERIFY=true`）并记录证书主体、颁发者、有效期与 SHA-256 指纹；
- 五类角色登录与完整权限矩阵（读取、导入、解析、复核、导出、配置、模型池、账号、审计、备份），越权必须 403；
- 共享任务/记录/图片读取、匿名拒绝；
- 真实模型闭环：供应商名称和 HTTPS 地址必须匹配主电脑上预先审批、已保存凭据的供应商；随后引用该供应商临时创建并验证视觉/文本模型、设为默认、执行连通性与能力检测（文本/JSON/视觉），导入 20–50 条脱敏 Excel 并完成整批解析；
- 对同一真实模型任务执行复核和导出，逐项验证原始字段和允许导出的 AI 字段已写入导出工作簿，并确认 `解析状态`、`复核状态`、`复核备注` 三个运行时字段未出现在业务导出工作簿中；
- 审计不泄漏凭据、关联 ID 贯通；
- 结束时恢复验收前默认模型（包括“原本无默认模型”的状态）和模型池设置，删除临时模型及无引用临时供应商，停用本次创建的全部角色账号；账号密码每次随机生成且不写入证据；
- 只有清理完整通过后才创建正式验收备份，并由服务端把同一个备份恢复到隔离临时目录，复制当前托管密钥执行完整校验，随后删除恢复副本。

未传 `-UpgradeImage` 时，验收脚本中的“升级预演”只表示同镜像重启和持久数据回归，不得记为真实升级兼容性证据。要验证真实升级，必须传入已经构建并审核过的另一个镜像标签，例如 `-UpgradeImage "customer-chat-analysis:<下一版本标签>"`。

### 6.1 用桩模型预演（可选，不作为签署证据）

正式提交真实 Key 前，可在工作站本地启动桩模型预热流程，确认脚本、防火墙与容器到主机的网络通路正常：

```powershell
node scripts/lan-acceptance-stub-model.mjs   # 监听 0.0.0.0:8788
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-lan-acceptance.ps1 `
  -ExternalEntry "https://<内部域名>" -RequireRealModel `
  -AdminPassword "<验收管理员密码>" `
  -ModelBaseUrl "http://host.docker.internal:8788/v1" `
  -ModelApiKey "stub-model-secret" -ModelName "stub-vision" -TextModelName "stub-text"
```

不带 `-Signoff` 时输出模式为 `field-drill`。桩模型、本机地址、私网模型地址、自签名证书、跳过 DNS、少于 20 条样本都只能生成预演结果，**不得**用于最终签署。

浏览器侧人工抽查（同机）：

1. 打开 `https://<内部域名>`，确认地址栏证书受信、页面无告警；
2. 管理员登录 → 退出 → 用另一浏览器会话确认旧会话已失效；
3. 打开一条记录图片，确认原图可查看；
4. 用另一个账号确认共享任务/记录可读取；
5. 抽查五类角色入口显隐，并确认越权操作返回服务端拒绝；
6. 在配置界面重新检测一次真实视觉/文本模型，确认能力检测通过且列表只显示掩码后的 Key。

## 步骤 7：主机侧人工补充检查（Issue 11-7）

在固定主机执行：

```powershell
# 自动检查已由 collect-lan-host-evidence.ps1 完成；这里补充核对正式目录与运维责任。
docker inspect customer-chat-analysis --format "{{json .Mounts}}"
docker inspect customer-chat-analysis --format "{{.Config.Image}} {{.Image}}"
docker logs --since 30m customer-chat-analysis
```

重启后重新登录核对：账号、任务、上传文件、图片、知识配置、模型凭据、日志和审计数据仍可用。

## 步骤 8：证据归档与脱敏（Issue 11-8）

保存以下脱敏证据：

| 证据 | 形式 | 脱敏要求 |
| --- | --- | --- |
| 主机规格与卷路径 | 文本表格 | 可保留设备名，隐去无关主机信息 |
| 证书 | 主体/颁发者/有效期/SHA-256 指纹 | 不含私钥与证书文件本身 |
| DNS | 解析记录截图或命令输出 | 仅保留内部域名与解析结果 |
| 防火墙 | 规则命令输出 | 网段可写成批准范围，不必暴露全部内网结构 |
| 固定主机 | `lan-host-evidence.json` | 仅包含镜像、挂载、备份恢复检查和主机规格，不含密钥 |
| 跨机验收 | `lan-field-evidence.json` | 脚本已排除密码/会话/API Key |
| 服务端拒绝 | 脚本步骤结果或浏览器截图 | 截图需遮盖个人信息 |
| 重启/单实例/恢复 | 命令输出 | 不含密钥内容 |

任何证据不得包含：密码、会话 Cookie、API Key、加密密钥、私钥、完整业务数据文件。

更新 [发布验收记录](../archive/lan-release-acceptance-2026-09-17.md) 中“真实第二台工作站”与基础设施待办，并回填 Issue 11、Issue 12 检查项。

## 通过标准

- 固定主机脚本输出 `HOST EVIDENCE OK`，证据中 `mode: host-signoff`、`restore.verified: true`、`persistence.managedKey: true`、`singleInstance.rejected: true`；
- 跨机脚本输出 `FIELD SIGNOFF OK`，证据中 `tlsVerified: true`、`acceptance.signoff.eligible: true`，且真实模型整批完成 20–50 条记录的解析、复核和导出；
- 浏览器侧抽查全部通过，越权请求均被服务端拒绝；
- 证据齐全且脱敏。

任一环节失败时保留现场证据、修复后重新执行对应步骤；不以本机自签名演练结果替代现场验收。
