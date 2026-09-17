# 架构治理进度账本

**计划：** `docs/architecture-remediation-plan-2026-09-17.md`

**最后更新：** 2026-09-17（T4 进行中）

## 恢复入口

- 当前任务：T4（结构化对象字段抽象）
- 当前步骤：确定 `StructuredFieldDefinition` 接口与前端渲染抽象边界
- 下一步：实现 `execution/structured.ts` 工厂并迁移未成交/接待 handler
- 工作区状态：T3 已提交；T4 未开始编码
- 恢复方法：读本入口 → 打开计划文档查看该任务未勾选步骤 → 继续执行，无需通读项目

## 任务计划表

状态取值：未开始 / 进行中 / 已完成 / 阻塞。

| 任务 | 状态 | 当前步骤 | 下一步 | 最近证据（命令 / 结果） | 阻塞或决策 |
| --- | --- | --- | --- | --- | --- |
| T1 迁移冻结与 catalog 单一真相源 | 已完成 | - | - | 552 项测试通过；`migrations-immutability` 红→绿→篡改即红；`npm run typecheck`、`build`、`db:check`（14/14，integrity ok）通过 | - |
| T2 模型池首启可行动 | 已完成 | - | - | 555 项测试通过；新增服务端 actions 与前端一键验证（点击前无请求、失败保留入口）；`typecheck`、`build`、`db:check`（14/14）通过 | - |
| T3 执行类型注册表 | 已完成 | - | - | `field-analysis-service.ts` 706 → 178 行；新增 `execution/` 9 个文件与 3 项注册表测试；558 项测试通过；`typecheck`、`build`、`db:check` 通过 | - |
| T4 结构化对象字段抽象 | 进行中 | 确定接口与前端抽象边界 | 实现 structured 工厂并迁移 | - | - |
| T5 前端工作区分层 | 未开始 | - | - | - | - |
| T6 质量闸门 | 未开始 | - | - | - | - |
| T7 文档治理 | 未开始 | - | - | - | - |
| T8 实例锁与平台健壮性 | 未开始 | - | - | - | - |

## 时间线日志

按时间倒序追加，每条格式：日期 / 任务 / 事件 / 证据。

- 2026-09-17 / T3 / 完成执行类型注册表 / `field-analysis-service.ts` 拆分为 `execution/`（registry、support、graph 与 5 个 handler 文件），调度器 706 → 178 行；`ANALYSIS_EXECUTION_TYPES` 常量派生 zod 枚举、catalog schema 与客户端选项；新增注册表测试 3 项；全量 558 项通过；`typecheck`、`build`、`db:check` 通过
- 2026-09-17 / T2 / 完成模型池首启引导 / `/api/ready` 增加 `actions.verifyPoolMemberIds`；模型池控制台显示待验证默认模型与“验证默认模型”按钮（`enablePassed: true`）；拦截提示改为“验证并启用”；新增 3 项测试；全量 555 项通过；重启服务后实机 `/api/ready` 200 且 `actions.verifyPoolMemberIds` 为空
- 2026-09-17 / T1 / 完成迁移冻结与 catalog 单一真相源 / 新增 `migrations-immutability.test.ts` 与 `migrations.lock.json`（13 个迁移）；篡改 006 后测试失败、恢复后通过；聚焦 28 项、全量 552 项测试通过；文档补充冻结规则与恢复提示
- 2026-09-17 / 计划 / 建立账本与任务计划表 / 本文件

## 决策日志

| 日期 | 任务 | 决策 | 原因 | 影响 |
| --- | --- | --- | --- | --- |
| 2026-09-17 | T3 | 执行类型字面量收敛规则：常量定义 + 每个 handler 注册一处 + 板块专属谓词（`isLostDealAttribution` 等 2 处） | 追求“活代码零字面量”会引入无意义的间接层，注册表本身就需要声明类型 | 验收口径改为“不再维护重复清单或 switch”，计划文档已同步 |
| 2026-09-17 | 全局 | 006 至 014 迁移冻结，只增不改 | 迁移 007 修改导致真实库与快照不一致 | 后续结构变更必须新增迁移 |
