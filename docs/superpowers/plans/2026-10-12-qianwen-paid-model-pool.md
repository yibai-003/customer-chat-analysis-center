# 百炼千问按量模型池实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除动态免费额度依赖，把满足能力条件的千问目录模型作为按量付费、待验证的模型池成员维护，同时保护基础模型和服务商配置。

**Architecture:** 保留现有预览/应用与 SQLite 事务边界，改为接收完整百炼模型目录并由纯策略函数过滤 Qwen 与文本/视觉能力。候选成员写入 `paid` 模式且默认 `pool_enabled=false`；基础模型、手工模型、服务商凭据和付费预算不参与同步修改。

**Tech Stack:** PowerShell 7、React、TypeScript、Express、Zod、SQLite、Vitest、Vite。

**Spec:** `docs/superpowers/specs/2026-10-12-qianwen-paid-model-pool-design.md`

## Global Constraints

- 不执行、不解析、不展示百炼免费额度或免费状态。
- 只纳入精确模型 ID 以 `qwen` 开头且满足当前文本/视觉/结构化输出能力条件的模型。
- 新增模型必须 `billing_mode='paid'` 且 `pool_enabled=false`；能力验证由管理员显式执行。
- 基础模型、手工模型、服务商增删改、API Key/Base URL、付费预算和历史用量不得被同步覆盖。
- 预览过期、池状态变化、权限失败或事务失败时零数据库修改。
- 不操作真实 LAN/生产数据库，不提交 `.env`、密钥、数据库或真实业务文件。
- 不 commit、push、merge 或创建 PR，除非用户另行明确要求。

---

### Task 1: 收窄目录快照契约和 Qwen 能力策略

**Files:**
- Modify: `src/shared/model-pool-sync.ts`
- Modify: `src/server/services/model-pool-sync-policy.ts`
- Modify: `src/server/services/model-pool-sync-policy.test.ts`

**Interfaces:**
- `BailianPoolSnapshot` 保留 `providerId`、`capturedAt`、`accountMatchConfirmed`，删除 `quotas`，只接收 `models`。
- `BailianPoolCandidate` 保留 `model`、`purpose`、目录显示信息和能力字段，删除免费额度字段。
- `selectBailianPoolCandidates(snapshot, now)` 返回 `{ candidates, excluded }`，候选只来自 Qwen ID；同一精确 ID 最多一个用途。

- [x] **Step 1: 写失败策略测试**，断言非 Qwen 被排除，文本/视觉/多模态 Qwen 按能力进入，缺结构化输出、缺模态、离线和重复目录被排除，并断言候选不包含额度字段。
- [x] **Step 2: 运行焦点测试确认失败**：`npm test -- src/server/services/model-pool-sync-policy.test.ts`；确认旧契约缺少所需行为。
- [x] **Step 3: 实现最小策略变更**：删除 quota schema/逻辑，增加大小写不敏感的 `isQianwenModelId`，按图片输入优先映射 vision，否则 text，保留结构化输出和目录完整性校验。
- [x] **Step 4: 重新运行焦点测试**：`npm test -- src/server/services/model-pool-sync-policy.test.ts`，全部通过。

### Task 2: 改造 CLI 采集器为目录模式

**Files:**
- Modify: `scripts/bailian-free-pool-sync.psm1`
- Modify: `scripts/sync-bailian-free-pool.ps1`
- Modify: `scripts/test-bailian-free-pool-sync.ps1`
- Modify: `package.json`

**Interfaces:**
- `ConvertFrom-BailianModelCatalogJson -Json` 解析完整模型目录；不再导出或调用 `ConvertFrom-BailianQuotaJson`。
- `New-BailianQianwenPoolSnapshot -ProviderId -ModelCatalogJson -AccountMatchConfirmed` 只生成目录快照。
- npm 命令使用 Qwen/paid 文案；旧函数名只在内部保留到本任务结束，不提供免费池提示。

- [x] **Step 1: 为完整目录、截断 JSON、重复模型、缺字段和非 Qwen 条目写离线失败测试**，并加入测试断言：脚本文本不包含 `usage free`/`bl usage free`。
- [x] **Step 2: 运行 `pwsh -NoProfile -File scripts/test-bailian-free-pool-sync.ps1`，确认新断言失败。**
- [x] **Step 3: 让脚本只调用白名单模型目录命令（如 `bl model list --output json --quiet`），限制响应体/记录数，规范化后再请求服务端；删除免费额度查询和按额度逐模型详情循环。**
- [x] **Step 4: 保留 loopback/HTTPS、进程内登录 Cookie、provider 选择和同账户人工确认；将预览/应用口令与输出改成按量千问模型池。**
- [x] **Step 5: 运行 PowerShell fixture 与 Parser 检查，确认没有真实 CLI、网络或数据库调用。**

### Task 3: 改造服务端预览/应用和数据库状态

**Files:**
- Modify: `src/server/services/bailian-free-pool-sync-service.ts`
- Modify: `src/server/services/bailian-free-pool-sync-service.test.ts`
- Modify: `src/server/routes/model-pool-router.ts`
- Modify: `src/server/routes/model-pool-router.test.ts`
- Modify: `src/server/services/model-pool-admin-service.ts`
- Modify: `src/server/services/model-pool-admin-service.test.ts`

**Interfaces:**
- `previewBailianFreePool`/`applyBailianFreePool` 可暂保留内部函数名以避免无意义 API 迁移，但只接受目录快照；响应字段和审计文案改为 Qwen/paid。
- 新候选插入为 `billing_mode='paid'`、`pool_enabled=0`，quota 列为 `NULL`/零默认值。
- 旧 `qianwen-free-pool`、`bailian-free-pool` 行原地迁移为新 paid 托管标记；缺失/非 Qwen 行停用但不删除。

- [x] **Step 1: 先写服务状态测试**：新候选 paid 未入池；重复目录幂等；旧免费行迁移保留 ID/能力/人工剔除；非 Qwen 旧行停用；基础模型/provider/API Key/付费预算/历史字段不变。
- [x] **Step 2: 写预览、权限和事务回滚测试**：无 quota 快照可预览；免费字段或非 Qwen 输入不产生候选；provider 停用、预览过期、池指纹变化和写入异常零修改。
- [x] **Step 3: 运行焦点服务/路由测试确认失败**：`npm test -- src/server/services/bailian-free-pool-sync-service.test.ts src/server/routes/model-pool-router.test.ts`。
- [x] **Step 4: 改造 schema、计划和 SQL**：删除 quota 访问与免费安全线，新增 paid 标记，保留 provider 验证、预览 TTL、指纹、权限、审计和单事务应用。
- [x] **Step 5: 重新运行焦点服务/路由测试**，旧静态安装入口不再存在且按量响应通过。

### Task 4: 更新模型池界面与文档

**Files:**
- Modify: `src/client/components/model-config/PoolView.tsx`
- Modify: `src/client/components/ModelConfigDialog.test.tsx`
- Modify: `docs/README.md`
- Modify: `docs/guides/bailian-free-model-pool-sync.md`
- Modify: `docs/superpowers/specs/2026-10-10-bailian-free-model-pool-sync-design.md`
- Modify: `docs/superpowers/plans/2026-10-10-bailian-free-model-pool-sync.md`

**Interfaces:**
- UI 显示“百炼千问目录同步”“按量计费/待验证”，不显示免费池安装按钮、免费额度或额度进度。
- 付费 purpose-default 模型在管理列表继续置底，但运行时优先于其他已验证付费模型；新模型验证/启用入口不变。

- [x] **Step 1: 写 UI 失败测试**，断言旧免费安装文案不出现、按量同步提示出现、默认模型置底。
- [x] **Step 2: 运行 `npm test -- src/client/components/ModelConfigDialog.test.tsx` 确认失败。**
- [x] **Step 3: 修改组件和文档，链接修订设计/计划；旧文档明确标为历史，不再作为操作入口。不需要 CSS 变更。**
- [x] **Step 4: 运行客户端焦点测试和 `git diff --check`。**

### Task 5: 全量验证

**Files:** 无新增生产文件；仅根据前面测试结果修复同一行为。

- [x] **Step 1: 运行 `npm test`：124 个测试文件、1012 个用例通过。**
- [x] **Step 2: 运行 `npm run typecheck`，通过。**
- [x] **Step 3: 运行 `npm run lint`，通过。**
- [x] **Step 4: 运行 `npm run build`，通过。**
- [x] **Step 5: 运行 `npm run db:check`、`npm run smoke`、`npm run check:installation`：通过；smoke 的 `ready=false` 因该隔离环境没有视觉/文本默认模型配置，健康、鉴权、审计和知识同步检查通过。**
- [x] **Step 6: 检查 `git diff --check`、`git status --short --branch` 和测试输出；未对真实 LAN 或百炼账户执行人工 apply/模型验证。**
