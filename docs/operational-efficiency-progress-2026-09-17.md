# 效能实施进度账本

**计划：** `docs/operational-efficiency-implementation-plan-2026-09-17.md`
**验收：** `docs/operational-efficiency-acceptance-criteria-2026-09-17.md`

## 恢复入口

- 当前任务：C 板块速度与 AI 字段合理性校验
- 当前步骤：AI 字段“是否消耗模型”元数据与效能聚合服务
- 下一步：只读 API、索引查询与效能界面
- 工作区状态：A、B 已提交，C 未开始
- 恢复方法：读本入口 → 打开计划文档对应章节 → 继续

## 任务计划表

| 任务 | 状态 | 当前步骤 | 证据 | 阻塞/决策 |
| --- | --- | --- | --- | --- |
| A1 通用验证接口与服务 | 已完成 | - | 新增 `POST /api/model-pool-members/verify`（复用同一服务），失败项返回 `errorCode`；验证失败不再自动剔除（按 MP-04） | 旧免费池路由保留为调用方 |
| A2 剔除/恢复语义与迁移 | 已完成 | - | 迁移 015（三字段+四个索引）；`removePoolMembers`/`restorePoolMembers`；重复/不存在/空/超限均 4xx | 恢复后需重新验证（能力状态不变） |
| A3 模型池批量操作界面 | 已完成 | - | 复选/全选/计数、验证已选、验证失败或过期项、剔除确认（原因+说明+最后可用提示）、恢复已选、状态列显示剔除原因与连续失败 | - |
| B1 记录选择与交互 | 已完成 | - | `useRecordSelection`（作用域=任务+板块+筛选，跨页保留，切换即清空）；记录列表复选与全选本页；`.record-select` 与复选框分离（勾选不打开详情）；工具栏“已选择 N 条/解析已选/清空选择” | 记录行由 button 改为 div+内层 button，7 处测试选择器同步更新 |
| B2 定向执行链路校验 | 已完成 | - | 服务端 `prepareTargetedRecordIds`：空/重复/跨任务/不存在/超 200 即 4xx；仅 pending/failed/needs_review 可执行；响应携带 `targeted{selected,executable,skipped}`；前端回显计数并在有跳过时清空失效选择 | 仍复用既有任务锁、取消、预算与轮询 |
| C1 效能聚合服务与 API | 未开始 | - | - | - |
| C2 AI 字段元数据与规则 | 未开始 | - | - | - |
| C3 效能界面 | 未开始 | - | - | - |
| 回归与文档 | 未开始 | - | - | - |

## 时间线

- 2026-09-17 / B / 完成记录多选与定向解析 / 服务端 4xx 校验与 `targeted` 计数；前端选择 hook、工具栏与对话框计数；全量 573 项通过；`typecheck`、`lint 0 error`、`build` 通过
- 2026-09-17 / A / 完成模型池验证与剔除 / 全量 569 项通过；`typecheck`、`lint 0 error`、`build`、`db:check` 通过
- 2026-09-17 / 计划 / 建立账本 / 本文件
