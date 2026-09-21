# 11: 真实局域网基础设施验收

**What to build:** 在固定运行主机、真实内网证书/DNS/防火墙和另一台物理局域网工作站上完成跨机验收，证明当前容器与权限实现能在实际局域网边界内安全使用。

**Blocked by:** 08: 管理员账号管理界面; 09: 审计追踪与管理操作界面; 10: 首次真实 CI 与发布工件追溯

**Status:** blocked-on-real-infrastructure (2026-09-21) — HTTP 跨机业务和五角色功能抽查已通过；内网 CA/DNS/防火墙/HTTPS、固定主机证据与正式发布环境仍待现场执行

- [ ] 固定运行主机使用主机本地 SSD 持久目录、固定内网地址和已通过 Issue 10 的镜像版本；记录操作系统、CPU、内存、磁盘和卷路径。
- [ ] 组织内网 CA 签发并部署受信证书，内网 DNS 将正式内部域名解析到 TLS 入口；不使用验收自签名证书或虚构域名作为最终证据。
- [ ] 反向代理保留预期 Host，应用的 `ALLOWED_HOSTS`、`ALLOWED_ORIGINS` 和安全 Cookie 配置与正式 HTTPS 地址一致。
- [ ] 主机防火墙只允许批准的局域网网段访问 HTTPS 入口；应用端口只绑定本机或内部容器网络，不存在公网映射、DMZ 暴露或未授权网段访问。
- [ ] 从另一台真实工作站完成证书受信、登录、退出、图片查看、任务共享读取和会话失效验证。*（2026-09-21 已确认另一台电脑完成五角色功能测试；当前入口为 HTTP，证书受信和正式 HTTPS 相关验证仍待执行）*
- [x] 现场抽查五类角色：管理员账号/审计/备份，配置人员配置与模型池，操作人员导入/解析，审核人员复核/导出，只读人员只读；所有越权请求由服务端返回 403。*（2026-09-21 用户确认五个角色已在另一台电脑完成各项功能测试且无问题；HTTPS 证书链仍单独待验收）*
- [ ] 容器重启后账号、任务、上传文件、图片、知识配置、模型凭据、日志和审计数据仍可用；第二实例无法同时写入同一 SQLite 数据库。
- [ ] 保存脱敏的主机、证书、DNS、防火墙、跨机浏览器和服务端拒绝证据，并更新 Issue 07 中“真实第二台工作站”和基础设施待办。

**已就绪的实现（2026-09-18）：**
- `scripts/verify-lan-acceptance.ps1` 新增现场模式：`-ExternalEntry https://<内部域名>` 跳过本地容器编排，直接对真实 HTTPS 入口执行验收；默认强制证书校验（`ACCEPTANCE_TLS_VERIFY=true`），记录证书主体/颁发者/有效期/SHA-256 指纹与 DNS 解析；`-AllowSelfSigned`/`-SkipDnsCheck`/`-ConnectHost` 仅用于预演。验收客户端新增 `ACCEPTANCE_CONNECT_HOST`、`ACCEPTANCE_ORIGIN` 与 TLS 校验控制，输出包含 `tlsVerified` 证据。
- 验收客户端支持重复执行：角色账号已存在时改用既定验收账号登录；临时停用账号使用唯一用户名，避免现场复跑冲突。
- 新增 [局域网现场验收执行手册](../../../docs/guides/lan-acceptance-runbook.md)：前置条件、主机与持久卷记录、内网 CA/DNS/TLS、部署已通过 CI 的镜像、防火墙与网络边界、跨机自动验收命令、浏览器侧抽查、主机侧重启/单实例/备份恢复检查、证据脱敏清单与通过标准。
- 预演验证：对保留的演练栈以现场模式复跑两轮均 `FIELD ACCEPTANCE OK`（14/14 步骤、97 条审计事件、备份创建成功，重复执行不冲突）；演练栈同时验证了带端口 Origin 的 `ALLOWED_ORIGINS` 配置。
- 真实验收进展（2026-09-21）：第二台电脑经 HTTP 入口完成真实业务使用，用户确认管理员、配置人员、操作人员、审核人员和只读人员的各项功能测试均无问题；正式 HTTPS、内网 CA/DNS、防火墙、固定主机与证书受信仍待现场执行。
- 本机 Field Drill（2026-09-21）：使用临时 HTTPS 反向代理、自签名证书、桩模型和 `sample-chat.xlsx` 完成 18/18 步骤；五角色权限、导入/解析/复核/导出、审计、备份恢复、同镜像升级重启、回滚和单实例保护均通过。证据见 `.scratch/lan-single-organization-upgrade/evidence/field-drill-2026-09-21.json`，不替代正式 HTTPS/真实供应商/跨机签收。
- 主机预检（2026-09-21）：已记录 Windows 10、Intel i9-10900KF、7.8 GB 内存、`172.16.20.178/24`（DHCP Disabled）、本地 NVMe SSD、Docker Server 29.6.2 和当前提交 `9a4c0f3e1cd641cf92ee3440a0e0c58b1b5350ca`。证据见 `.scratch/lan-single-organization-upgrade/evidence/host-preflight-2026-09-21.json`；由于当前没有 CI 批准镜像对应的正式容器，暂不生成 `host-signoff`。

## 2026-09-21 正式主机前置条件复核

- 当前运行容器为 `lan-preview`，镜像 `customer-chat-analysis-center:0.1.0-ui-atelier-20260920-r5`，不是当前提交对应的 CI 批准镜像。
- 当前入口为 `http://172.16.20.178:8788`，容器端口发布为 `0.0.0.0:8788 -> 8787`；尚未切换到可信内网 CA 证书、内部 DNS 和 HTTPS 入口。
- 当前容器环境仍为 `ALLOWED_ORIGINS=http://172.16.20.178:8788`、`SESSION_COOKIE_SECURE=false`，不满足正式 HTTPS 配置要求。
- 本机 Windows `Domain`、`Private`、`Public` 三个防火墙配置文件均为关闭状态，当前不能证明只允许批准网段访问 HTTPS 入口。
- 以上结果只作为脱敏前置检查记录，不生成正式 `host-signoff`，也不关闭 Issue 07/11/12 的正式 HTTPS、CI 工件和最终发布签字条件。

## 2026-09-21 当前提交 Field Drill

- 使用当前提交 `b1c6920` 重建临时镜像 `customer-chat-analysis:verify-b1c6920`，本地镜像摘要为 `sha256:852fe3d947fcf34e3493e0dab199d6dc9c32dcdd06142b15f3b2fee6f8ca7fe7`。
- 临时 HTTPS 入口 `https://chat.example.lan:18444` 下 18/18 步骤通过，覆盖五角色、共享读取、越权拒绝、导入、图片、复核、导出、模型配置、模型调用、审计、备份恢复、回滚和单实例。
- 预演模型调用 1 次、30 tokens，记录完成并完成复核与导出；备份恢复检查 5 项通过，回滚后任务数为 2，证据见 `.scratch/lan-single-organization-upgrade/evidence/field-drill-b1c6920-2026-09-21.json`。
- 该结果明确为 Field Drill：使用自签名证书、跳过 DNS、桩模型、单条样本和单机环境；`signoff.eligible=false`，缺口为 `trusted-tls`、`internal-dns`、`real-model-provider`、`sample-count`、`cross-machine`，不替代正式主机签收。
