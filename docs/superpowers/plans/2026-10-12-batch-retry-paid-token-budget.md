# 批次失败记录重试预算实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each behavior before implementation.

**Goal:** 失败记录重试使用可配置的独立付费 Token 预算，不再固定为 0。

**Architecture:** 复用现有批量运行设置弹窗与预算上下文。失败重试先读取系统容量并展示并发、批次及 Token 设置，服务端严格校验选项，重试服务只重置并解析失败记录，并在新的付费 Token 预算上下文内运行。

**Tech Stack:** React、TypeScript、Express、Zod、Vitest。

**Spec:** GitHub Issue #17。

## Global Constraints

- 重试只作用于失败记录，不要求重新导入。
- 每次重试是一轮新的付费 Token 预算；不回写旧用量。
- 暂停、取消、任务锁和重置回滚语义保持不变。
- 不触碰真实 LAN 数据库或根工作区的 Issue #12 未提交文件。

---

### Task 1: 服务和 API 预算透传

**Files:** `src/server/services/batch-analysis-service.ts`, `src/server/app.ts`, `src/server/services/batch-analysis-service.test.ts`

- [x] 添加预算上下文失败回归测试并观察到实际预算为 0。
- [x] 添加 API 契约测试并观察到 retry starter 未收到请求中的选项。
- [x] 在 API 校验并透传并发、批次和 maxPaidTokens。
- [x] 在失败记录重试服务中将选项与 recordIds 合并，并包入付费 Token 预算上下文。
- [x] 验证预算透传、失败记录重置回滚和非法预算拒绝。

### Task 2: 重试设置 UI

**Files:** `src/client/components/AnalysisRunDialog.tsx`, `src/client/components/AnalysisRunDialog.test.tsx`, `src/client/hooks/useAnalysisActions.ts`, `src/client/hooks/useWorkspaceController.ts`, `src/client/App.tsx`, `src/client/App.test.tsx`

- [x] 先添加失败 UI 测试，要求重试预算可编辑并预填上次设置。
- [x] 重试失败按钮加载容量并打开专用意图的运行设置弹窗。
- [x] 将确认选项通过 `/retry-failed` 请求体发送。
- [x] 按任务保存在 localStorage 中最近使用的 Token 上限；储存不可用时回退到当前会话值/0。
- [x] 验证 UI 设置、请求体、现有普通批量弹窗和运行选项校验。

### Task 3: 验证和交付

- [x] 运行焦点测试、全量测试、类型检查、lint、build、smoke、安装检查；焦点 79/79 通过，全量有 1 个不相关模型服务商优先级测试失败。
- [x] `db:check` 因隔离重试 worktree 无 branch-specific 数据快照而失败；未创建空数据库或复制日用数据。
- [x] 复跑并记录不相关的服务商优先级测试仍失败，没有修改该测试或模型路由。
- [x] 检查 diff；根目录 Issue #12 工作区保留原状。
