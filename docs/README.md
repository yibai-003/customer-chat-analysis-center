# 文档索引

本目录只保留索引、活跃计划与长期流程；长期指南在 `guides/`，一次性实施与验收记录在 `archive/`，历史设计在 `superpowers/`。

## 主题索引

### 启动
- [本地访问与启动配置](guides/local-access-and-startup.md)
- [官方源可复现安装](guides/reproducible-installation.md)

### 局域网部署与运维
- [局域网部署与单实例运行](guides/lan-deployment.md)
- [局域网运维手册](guides/lan-operations.md)
- [局域网现场验收执行手册](guides/lan-acceptance-runbook.md)

### CI
- [CI 质量闸门与发布工件](guides/ci-quality-gates.md)

### 配置
- [服务端输入约束](guides/server-input-validation.md)
- [大文件 Excel 导入处理流程](guides/large-file-processing-flow.md)

### 同步
- [知识快照同步失败恢复](guides/knowledge-sync-recovery.md)
- [热点话题：补全问题与知识沉淀](guides/hot-topic-knowledge-capture.md)

### 迁移
- [数据库迁移与进程恢复](guides/database-migrations-and-recovery.md)

### 备份
- [备份与恢复指南](guides/backup-and-recovery.md)

### 维护
- [安全清理与日志轮换](guides/safe-maintenance-and-logs.md)

### 安全
- [Excel 上传安全与资源限制](guides/upload-safety.md)
- [XLSX 资源关系校验](guides/xlsx-resource-validation.md)
- [上传与导入共享磁盘预留](guides/shared-disk-reservations.md)
- [加密密钥管理与迁移](guides/encryption-key-management.md)

### 模型池
- [取消链路与模型请求预算](guides/cancellation-and-model-budget.md)
- 免费模型池实施计划（`superpowers/plans/2026-09-16-model-pool.md`）
- 免费模型池设计（`superpowers/specs/2026-09-16-model-pool-design.md`）

## 项目规范

- [项目目录结构与后续开发规范](project-structure-and-development-guidelines.md)

## 活跃计划与流程

- [架构与结构性重复治理实施计划](architecture-remediation-plan-2026-09-17.md)
- [架构治理进度账本](architecture-remediation-progress.md)
- [项目稳定性开发流程](stability-development-workflow.md)
- [模型池、批量选择与解析效能实施计划](operational-efficiency-implementation-plan-2026-09-17.md)
- [模型池、批量选择与解析效能验收标准](operational-efficiency-acceptance-criteria-2026-09-17.md)

## 架构决策

- [ADR-0001：局域网版采用单组织共享数据与角色授权](adr/0001-lan-single-organization-access-model.md)
- [ADR-0002：模型供应商凭据集中管理](adr/0002-centralized-model-provider-credentials.md)

## 归档

一次性实施记录、已完成的修复清单与历史验证文档，保留备查：

- [定向稳定性与安全改进计划（2026-09-13）](archive/targeted-stability-remediation-plan.md)
- [个人使用阶段方案与实施计划](archive/personal-use-implementation-plan.md)
- [当前项目修复清单（2026-09-17）](archive/fix-plan-2026-09-17.md)
- [后续推进计划（2026-09-17）](archive/follow-up-plan-2026-09-17.md)
- [配置 Schema 与热点错误分类验证](archive/configuration-and-hot-topic-validation.md)
- [依赖漏洞定向修复](archive/dependency-security-remediation.md)
- [容器化备份与独立恢复演练（2026-09-17）](archive/lan-backup-restore-drill-2026-09-17.md)
- [局域网发布验收记录（2026-09-17）](archive/lan-release-acceptance-2026-09-17.md)
- [局域网真实业务验收记录（2026-09-18）](archive/lan-real-business-acceptance-2026-09-18.md)
- [前端状态模块拆分记录](archive/frontend-state-modules.md)
- [Task 8 实施报告](archive/task-8-report.md)
- [Task 9 实施报告](archive/task-9-report.md)
- [Task 10 迁移修复报告](archive/task-10-fix-migration-report.md)
- [Task 10 就绪校验报告](archive/task-10-fix-readiness-report.md)
- [Task 10 路由修复报告](archive/task-10-fix-routing-report.md)

## 文档约定

新增文档使用“目的 / 实施顺序 / 验收 / 回退”模板；一次性验收记录直接放入 `archive/`，不再新增流水账式报告。计划类文档在完成后移入 `archive/`，并从本索引更新链接。
