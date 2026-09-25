# 文档中心

本页是项目文档的唯一总入口。请先按角色选择文档，不需要从目录中逐份查找。

## 快速入口

| 使用者 | 建议从这里开始 |
| --- | --- |
| 局域网普通用户 | [局域网其他电脑访问使用手册](guides/lan-client-access.md) |
| 部署与运维管理员 | [局域网部署与单实例运行](guides/lan-deployment.md) |
| 日常系统管理员 | [局域网运维手册](guides/lan-operations.md) |
| 项目开发者 | [项目目录结构与后续开发规范](project-structure-and-development-guidelines.md) |
| 正式验收人员 | [局域网现场验收执行手册](guides/lan-acceptance-runbook.md) |

## 普通用户

- [局域网其他电脑访问使用手册](guides/lan-client-access.md)：安装根证书、配置
  `hosts`、检查端口并登录。
- [热点话题：问题提炼与知识积累](guides/hot-topic-knowledge-capture.md)：维护热点问题与知识条目。

普通用户不需要阅读部署脚本、历史计划、验收证据或开发设计。

## 部署与运维管理员

### 部署和访问

- [局域网部署与单实例运行](guides/lan-deployment.md)
- [本地访问防护与启动配置](guides/local-access-and-startup.md)
- [官方依赖源与可复现安装](guides/reproducible-installation.md)

### 日常运行

- [局域网运维手册](guides/lan-operations.md)
- [完整备份与恢复](guides/backup-and-recovery.md)
- [独立加密密钥与旧数据迁移](guides/encryption-key-management.md)
- [数据库迁移与进程恢复](guides/database-migrations-and-recovery.md)
- [安全清理与日志轮换](guides/safe-maintenance-and-logs.md)
- [知识快照同步失败恢复](guides/knowledge-sync-recovery.md)

### 容量和安全

- [Excel 上传安全与资源限制](guides/upload-safety.md)
- [上传与导入共享磁盘预留](guides/shared-disk-reservations.md)
- [XLSX 资源与关系校验](guides/xlsx-resource-validation.md)
- [大文件 Excel 处理流程](guides/large-file-processing-flow.md)

## 开发者

- [Agent 协作规则](../AGENTS.md)
- [项目工作约定](project-work-agreement.md)
- [项目目录结构与后续开发规范](project-structure-and-development-guidelines.md)
- [CI 质量闸门与发布工件](guides/ci-quality-gates.md)
- [服务端输入约束](guides/server-input-validation.md)
- [取消链路与模型请求总预算](guides/cancellation-and-model-budget.md)
- [数据库迁移与进程恢复](guides/database-migrations-and-recovery.md)
- [大文件 Excel 处理流程](guides/large-file-processing-flow.md)

架构决策：

- [ADR-0001：局域网版采用单组织共享数据与角色授权](adr/0001-lan-single-organization-access-model.md)
- [ADR-0002：模型供应商凭据集中管理](adr/0002-centralized-model-provider-credentials.md)

## 正式验收

- [局域网现场验收执行手册](guides/lan-acceptance-runbook.md)
- [CI 质量闸门与发布工件](guides/ci-quality-gates.md)
- [局域网真实业务验收记录](archive/lan-real-business-acceptance-2026-09-18.md)
- [局域网发布验收记录](archive/lan-release-acceptance-2026-09-17.md)

验收记录只说明特定日期和版本的结果，不能替代当前运行环境检查。

## 历史与内部材料

- [`archive/`](archive/README.md)：已经完成的实施计划、验收记录和修复报告。
- [`superpowers/`](superpowers/README.md)：功能设计和实施计划，主要用于追溯决策。
- [`.scratch/`](../.scratch/)：任务工单与现场过程材料，不是用户操作说明。
- [`.superpowers/`](../.superpowers/)：代理执行过程记录，不是项目权威文档。

遇到历史材料与当前指南冲突时，以以下顺序为准：

1. 当前代码、配置模板和自动化测试；
2. `docs/guides/` 当前有效指南；
3. `docs/adr/` 架构决策；
4. `docs/archive/`、`docs/superpowers/`、`.scratch/` 历史材料。

## 文档维护规则

- 长期有效的操作方法放入 `guides/`。
- 架构约束和不可轻易改变的决策放入 `adr/`。
- 已完成的计划、进度账本、一次性验收和修复报告放入 `archive/`。
- 设计与实施计划放入 `superpowers/`，完成后不再作为日常入口。
- 新增长期指南使用“目的 / 实施顺序 / 验收 / 回退”结构。
- 不在 README 或多个指南中复制同一组完整操作步骤；保留一个权威说明，其余位置使用链接。
- 含密码、Cookie、API Key、私钥、数据库或完整业务数据的内容不得写入文档和证据。
