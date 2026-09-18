# 局域网发布验收记录（2026-09-17）

对应 Issue 07：在正式发布前证明身份授权、共享数据、审计、镜像持久化、内部 HTTPS、备份恢复与质量闸门共同成立。

## 结论

- **机器等价验收通过**：在固定主机上通过独立的内网 HTTPS 入口（保留原始 Host/Origin）完成五角色权限矩阵、共享数据、拒绝、审计、镜像持久化/升级/回滚、备份与独立恢复校验、单实例保护。
- **首次真实 CI 与发布工件追溯通过**：代码已提交并推送，GitHub Actions 干净 runner 全闸门通过并产出可下载的发布候选工件，`manifest.json` 与运行记录一致（见下节）。
- **尚待人工确认**：真实“另一台局域网工作站”访问、组织内网 CA/DNS 与防火墙网段策略。清单见文末。

## 首次真实 CI 与发布工件（2026-09-18 检查）

| 项目 | 记录 |
| --- | --- |
| 成功运行 | [#35294240397](https://github.com/yibai-003/customer-chat-analysis-center/actions/runs/35294240397)（push 到 `main`，conclusion `success`） |
| 提交 | `b4341f3ce74db5d9876615bac82ade72af38023c`（完整 SHA 与 manifest.commit 一致） |
| 质量作业 | `npm ci`、`check:installation`、657 项测试、typecheck、lint、build、`db:init`、`db:check`、smoke 全部 success；node `v22.23.2`，迁移版本 17 |
| 发布作业 | `docker build` 成功（无推送、无部署），工件上传成功 |
| 工件名称 | `customer-chat-analysis-center-release-candidate`（artifact id `10526444673`，737551 字节，保留 30 天） |
| 工件摘要 | `sha256:b4f6d2347edf0655c0dab1bda0f68580d15e958a76697a9b7ca530ab0637a490` |
| 镜像 | `customer-chat-analysis-center:0.1.0-b4341f3ce74d`，镜像 ID `sha256:1b9bcff0a8e580700e750b71c7179a0cdd66421172613069a3b09a558595e294`（与 CI 日志一致） |
| 工件内容 | `dist/`（含构建资产）、`src/server`、`src/shared`、`knowledge`、`config`、`package.json`、`package-lock.json`；不含 `node_modules`、`.env`、密钥或业务数据；manifest 标注运行要求为 `npm ci` + Node 22.12+ 或直接使用镜像 |

首次运行暴露并修复了两个工件问题：`package.json` 缺少 `version` 导致镜像标签为 `undefined`；发布目录使用点开头的 `.release/` 被 `upload-artifact` 按隐藏路径跳过。修复后重新运行并通过。此前失败运行（质量闸门失败）均未产出发布候选工件，发布作业按 `needs` 依赖跳过。

## 环境

| 项目 | 值 |
| --- | --- |
| 主机 | Windows 10（NT 10.0.19045），Intel i9-10900KF，15.8 GB 内存 |
| 运行时 | Docker Engine 29.6.2（Docker Desktop） |
| 镜像 | `customer-chat-analysis:acceptance`，ID `sha256:be348d25b51430c70c3c3d453f7a9e13168d60e5658a3d2e17d3551285d26dd4` |
| 内网入口 | `https://chat.example.lan:8443`（验收自签名证书，仅本次演练） |
| 数据卷 | 临时目录 `DATA_DIR`/`KNOWLEDGE_DIR` 绑定挂载（生产为固定主机本地目录） |
| 复跑脚本 | `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-lan-acceptance.ps1`（无 Docker 时返回码 2 跳过） |

## 验收覆盖与证据

| Issue 07 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 五角色权限矩阵（HTTPS 登录） | 通过（机器等价） | 客户端 14/14 步骤通过，耗时 4.3s；管理员能力 11 项；账号创建 5 个 |
| 共享读取与服务端拒绝 | 通过 | 五角色读取任务/板块/模型 200；匿名 401；图片五角色 200、匿名 401；导入、复核、导出、配置、模型池、解析、账号管理的越权请求全部 403 |
| 审计准确、不泄漏凭据 | 通过 | 51 条事件、18 类动作、25 条拒绝；必需动作含 `auth.login`、`identity.create_user/update_user`、`task.import/start_analysis/pause/cancel/export`、`review.save`、`config.upsert_section/create_model`、`pool.update_settings`、`backup.create`；复核事件带 `x-request-id` 关联；事件中无密码/会话/API Key |
| 重启、镜像升级与单实例 | 通过 | 升级预演后任务数 1、托管密钥存在；回滚到原标签后任务数 1；容器内再次启动入口被拒绝（单实例锁） |
| 备份与独立恢复 | 通过 | API 备份 5 文件/3 引用；独立目录恢复后 `restore:verify` 5 项全绿：标记、数据库版本 17、2 个引用文件、知识快照哈希、`models:1` 且密钥 `decryptable` |
| 质量闸门（本机等价） | 通过 | `npm ci`/安装检查/628 项测试/类型检查/lint 构建/`db:init`/`db:check`/冒烟全部通过；CI 工作流见 `docs/guides/ci-quality-gates.md` |
| 记录规格与前置条件 | 通过 | 本文 |

关键明细（验收证据 JSON）：

- 客户端步骤全部 `ok: true`，含 `https-health`、`admin-login`、`create-role-accounts`、`shared-reads`、`anonymous-denied`、`import-as-operator`、`image-shared-view`、`review-matrix`、`export-matrix`、`configuration-and-pool`、`analysis-lifecycle`、`account-disable`、`backup-through-api`、`audit-trail`。
- 备份包：`full-2026-09-17T09-48-53-424Z-7a4e4174-f45f-4e55-813e-9e41f581db3b`；恢复目录校验时间约 1 秒。
- 内网入口配置：`LISTEN_HOST=0.0.0.0`、`ALLOWED_HOSTS=chat.example.lan`、`ALLOWED_ORIGINS=https://chat.example.lan`、`SESSION_COOKIE_SECURE=true`；TLS 由 nginx 终止并保留 `Host`。

## 已知限制与残留风险

1. **无真实第二台工作站**：本次由主机上的独立 HTTPS 客户端模拟内网工作站（真实 Host/Origin、TLS、拒绝矩阵），未跨物理机验证。跨机验收需按文末清单执行。
2. **证书与 DNS**：使用自签名证书与虚构域名；生产必须替换为组织内网 CA 证书、内网 DNS 与防火墙网段放行。
3. **CI 已真实验证**：首次运行曾因时区依赖断言与过紧的竞态超时失败；已在 Node 22 + `TZ=UTC` 下复现修复并重新运行通过。后续仍以 CI 为准，不以本地通过替代。
4. **模型能力未验收**：验收库仅创建 1 个未验证的模型配置；真实解析依赖供应商凭据与能力检测，属于下一阶段线上化验证。
5. **数据规模**：演练数据为小样本（1 条记录）；生产数据达 GB 级时需重新测量备份/恢复耗时与磁盘占用。
6. **平台差异**：演练在 Windows + Docker Desktop；若生产主机为 Linux，需用同一脚本复跑一次。
7. **审计保留**：审计为追加写入且不可修改删除，长期运行需要容量与归档策略。

## 下一阶段线上化前置条件

- 固定局域网主机就位（本机磁盘、固定内网地址、Docker 或 Windows 服务等价运行时）。
- 组织内网 CA 签发证书、内网 DNS 解析、防火墙仅放行批准网段，禁止公网映射。
- 首次 CI 运行通过并留存工件与 `manifest.json`（提交/镜像标签可追溯）。
- 配置真实模型供应商凭据，完成一次真实导入→解析→复核→导出闭环。
- 按主机规模评估磁盘与备份保留策略，并完成一次 Linux（若适用）与一次全量数据恢复演练。
- 管理员账号、密钥文件与备份的保管责任落实到人。

## 人工待办清单（完成即视为发布验收通过）

1. 在另一台局域网工作站打开 `https://<内网域名>`，用管理员登录，确认证书受信、页面与图片正常。
2. 现场抽查操作人员可导入/发起解析、审核人员可复核/导出、只读人员无修改入口，并确认服务端对越权请求返回 403。
3. 在真实主机上执行 `scripts/verify-lan-acceptance.ps1`（或等效操作）并保存证据 JSON。
4. 用真实模型凭据完成一次解析闭环，并把结果补记到本文件。

（CI 运行与工件追溯已于 2026-09-18 完成，见“首次真实 CI 与发布工件”。）
