# 容器化备份与独立恢复演练（2026-09-17）

对应 Issue 06 第 4 项：发布前完成一次容器化运行的备份与独立恢复演练，记录恢复时间、验证结果与残留风险。

## 环境

- 主机：Windows + Docker Desktop，Docker Engine 29.6.2。
- 镜像：`customer-chat-analysis:drill`（镜像 ID `660588f80df7`，由当前工作副本按 `Dockerfile` 构建）。
- 运行：容器 `lan-backup-drill-app`，数据卷挂载 `DATA_DIR` 与 `KNOWLEDGE_DIR` 到临时主机目录，容器内 `LISTEN_HOST=0.0.0.0`。
- 复跑脚本：`pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-backup-restore.ps1`（本机无 Docker 时返回码 2 跳过）。

## 步骤与结果

| 步骤 | 动作 | 结果 | 耗时 |
| --- | --- | --- | --- |
| 1 | 构建镜像并启动容器，等待健康检查 | `healthy` | 镜像层缓存命中，构建约 25s |
| 2 | 写入演练数据：1 个任务、1 条记录、1 张图片引用 | `job=e1021a60…`、`record=fcbc0541…` | < 2s |
| 3 | 容器内 `npm run backup` | 生成 `full-2026-09-17T09-29-14-618Z-13a915b8-…`，3 个文件、2 个引用，校验通过 | **3.8s** |
| 4 | `npm run restore -- <备份> --to /tmp/backup-drill-restore` | 恢复到独立目录成功 | **1.6s** |
| 5 | 放入托管密钥后 `npm run restore:verify -- <恢复目录>` | 5 项全部 `ok: true` | **0.6s** |
| 6 | 独立抽查 | 数据库中的图片引用在恢复目录可读，`RESTORED.json` 存在 | < 1s |

`restore:verify` 通过项：

- `restored-marker`：恢复标记存在；
- `database`：完整性/外键通过，迁移版本 17 与程序一致；
- `file-references`：数据库引用的 2 个文件全部存在；
- `knowledge-catalog`：知识快照结构合法，与同步状态哈希一致；
- `model-credentials`：托管密钥可用（本次演练库无模型凭据，返回 `models: 0, decryptable: true`）。

## 验收结论

- 备份不依赖镜像层：删除/重建容器后数据仍在，备份仅从挂载卷生成。
- 恢复始终写入独立目录，原环境未被修改。
- 恢复环境在替换运行数据前可被机器校验（数据库、文件、知识、密钥四项）。
- 小数据量下备份 + 恢复 + 校验总耗时约 6 秒；时间随数据量近似线性增长。

## 残留风险

1. **密钥保管依赖人工流程**：完整备份刻意不含 `.secrets` 密钥文件；演练中手动复制了托管密钥。若运维遗漏密钥副本，恢复环境无法解密模型凭据（`restore:verify` 会失败并阻止切换，但业务停机时间会变长）。
2. **大文件量未实测**：演练数据集很小；生产库达到 GB 级时备份/恢复耗时与磁盘占用需要按主机重新评估。
3. **切换未实跑**：演练只验证恢复副本，未执行“停止原服务并切换数据目录”的完整切换；切换属于人工步骤，Issue 07 的局域网验收中再覆盖。
4. **TLS/反向代理未纳入演练**：本演练覆盖数据面；内部 HTTPS 与网段限制需要 Issue 07 的跨主机验收。
5. **平台差异**：本机为 Docker Desktop（Windows 卷权限与 Linux 主机不同）；生产主机为 Linux 时需按同一脚本复跑一次。
6. **CLI 备份无 HTTP 审计**：演练使用主机本地 `npm run backup`；管理员通过 `POST /api/admin/backups` 的备份/恢复会写入 `backup.create` / `backup.restore` 审计（已有集成测试覆盖）。
