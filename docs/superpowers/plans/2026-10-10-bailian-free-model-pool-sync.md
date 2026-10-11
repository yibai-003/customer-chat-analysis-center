# 百炼免费模型池动态同步实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用本机授权的 Bailian CLI 安全同步符合当前免费额度与能力标准的百炼模型，并保留两个付费默认模型作为列表和路由末尾兜底。

**Architecture:** Windows PowerShell 采集器把去敏额度/目录快照送入受 `config:manage` 保护的服务端预览与应用流程。服务端集中执行筛选和差异计算，以单实例内存短期预览状态防止过期/并发覆盖，并通过 SQLite 单事务应用。UI 提供命令入口说明、刷新后的变更状态，并将付费默认成员固定置底。

**Tech Stack:** Windows PowerShell 7、Bailian CLI (`bl`)、React、TypeScript、Express、Zod、SQLite、Vitest。

**Implementation status:** Tasks 0–5 completed and verified in the isolated feature worktree. Task 6 (LAN end-to-end apply) is intentionally pending explicit authorization for an exact isolated test target and backup; no LAN or production database was touched.

**Spec:** [百炼免费模型池动态同步设计](../specs/2026-10-10-bailian-free-model-pool-sync-design.md)，GitHub [Issue #16](https://github.com/yibai-003/customer-chat-analysis-center/issues/16)

## Global Constraints

- CLI 登录配置不得复制或挂载进 Docker；同步快照不得包含 CLI 凭据、项目 Cookie、密码或模型 API Key。
- 项目 provider 仍由服务端集中持有；必须显式绑定一个已启用的百炼 provider，不得在多个候选中猜选。
- 快照和账户目录按完整模型 ID（包括快照版本）匹配；额度模型只分配到一个用途。
- `autoStop` 必须为 `true`；剩余额度必须高于现有 95% 本地安全线，且未过期、未下线、能力符合项目标准。
- 新发现的模型 `pool_enabled=false`；同步和预览不调用推理 API。启用前必须通过现有能力验证。
- 过期、耗尽、下线或不合格成员退出活动池但保留数据和历史；手动剔除状态不自动恢复。
- 两个 `is_purpose_default=true` 的付费默认模型、provider 凭证、预算设置和历史记录不得被同步修改；服务端路由与界面都将其置底。
- 同步应用在一个 SQLite 事务中完成；写入失败时全量回滚。CLI 不完整、预览失效或 provider 状态变化时零模型池修改。
- 合法零候选预览须显示全部停用数量，并要求键入 `STOP ALL MANAGED FREE MODELS` 才能应用。
- 保留当前工作区已有 Issue #12 未提交改动；实现开始前在独立 worktree 依本地 `main` 基线建分支。
- 不备份、替换或修改任何当前正式版/日用版数据库。触碰测试 LAN 运行数据前须先确认准确的测试环境路径和数据备份/恢复授权。
- 未获用户请求不得 commit、push、merge 或创建 PR。

---

## 文件与模块边界

| 路径 | 职责 |
| --- | --- |
| `src/shared/model-pool-sync.ts` | 规范化的 Bailian 额度快照、模型目录条目、候选与预览结果契约。 |
| `src/server/services/model-pool-sync-policy.ts` | 纯函数校验额度与目录、匹配完整 ID、计算文本/视觉用途及排除原因。 |
| `src/server/services/model-pool-sync-policy.test.ts` | 额度边界、版本精确匹配、能力、过期、安全线、付费保护规则。 |
| `scripts/bailian-free-pool-sync.psm1` | PowerShell CLI JSON 解析、模型详情收集和去敏快照构造函数。 |
| `scripts/sync-bailian-free-pool.ps1` | 交互登录项目、调用预览、显示差异、确认后应用的主机入口。 |
| `scripts/test-bailian-free-pool-sync.ps1` | 不依赖 Pester 或真实阿里云账户的 CLI 解析器回归。 |
| `src/server/services/bailian-free-pool-sync-service.ts` | Provider 校验、预览快照缓存、差异计划、原子写入和旧静态成员接管。 |
| `src/server/services/bailian-free-pool-sync-service.test.ts` | 模型池数据库状态、幂等、手动状态保留、事务回滚和过期预览。 |
| `src/server/routes/model-pool-router.ts` | 增加管理员预览/应用路由并移除旧静态安装入口。 |
| `src/server/routes/model-pool-router.test.ts` | 鉴权、权限、输入错误、审计脱敏与端到端预览/应用。 |
| `src/client/components/model-config/PoolView.tsx` | 删除静态预设安装动作，提供本机命令提示与付费默认置底排序。 |
| `src/client/components/ModelConfigDialog.test.tsx` | 模型池命令提示、免费/付费默认行顺序及旧交互回归。 |
| `src/client/styles.css` | 命令提示沿用现有模型控制台视觉，不新增独立设计系统。 |
| `package.json` | 添加 Windows 主机同步的稳定 npm 命令入口。 |
| `docs/guides/bailian-free-model-pool-sync.md` | CLI 登录前置、测试/正式 URL 安全区分、预览/确认/验证步骤和失败恢复。 |
| `docs/README.md` | 链接新增设计、实施计划和长期同步操作指南。 |
| `src/server/services/qianwen-free-pool-preset.ts` | 移除已被动态同步取代的静态百炼免费模型与过期额度清单。 |
| `src/server/services/qianwen-free-pool-preset.test.ts` | 将静态名单测试替换为动态筛选/兼容测试，不降低既有行为覆盖。 |
| `src/server/services/model-pool-admin-service.test.ts` | 将静态安装断言替换为动态管理服务行为验证，保留其它管理服务回归。 |

无新数据库字段时不添加迁移。如实现证明现有字段不足，先暂停并更新规格/本计划，再新增有序 migration、migration lock 与迁移测试；禁止改写既有发布迁移。

---

### Task 0: 建立隔离实现与测试基线

**Files:** 无。

**接口：** 此任务只准备 worktree、依赖和测试约定，不改写当前 root worktree 的内容。

- [ ] **Step 1: 记录当前工作树状态。**

运行 `git status --short`、`git branch --show-current`、`git worktree list --porcelain`。确认 root 中 `src/server/services/reception-quality-legacy.ts` 的修改及 `reception-quality-legacy.test.ts` 未跟踪文件仍在；不暂存、不移动、不清理。

- [ ] **Step 2: 核对本地 main 基线。**

运行 `git rev-list --left-right --count main...origin/main`，再读取 `git log -1 --oneline main`。分清 local-only 与 remote-only 提交；新分支以本地 `main` 为准，不静默换成 `origin/main`。如果本地 main 落后或分歧会改变目标基线，先报告并暂停，不通过重置或强制更新解决。

- [ ] **Step 3: 依 `superpowers:using-git-worktrees` 创建独立分支。**

在实现 turn 中读取该 skill，再运行：

```powershell
git worktree add .worktrees/feat-bailian-free-model-pool-sync -b feat/bailian-free-model-pool-sync main
Set-Location .worktrees/feat-bailian-free-model-pool-sync
npm ci
```

预期：当前 #12 工作树未变化；新 worktree 位于 `feat/bailian-free-model-pool-sync` 并从已核对的本地 main commit 建立。

- [ ] **Step 4: 确认 Vitest 不连接运行数据库。**

检查 `vitest.config.*`、`src/test/` 和数据库测试初始化；运行一个既有 service test，确认测试使用隔离数据库。后续新增测试必须经测试 DB fixture，不读 `.env`、LAN SQLite、真实 key 或聊天业务文件。

---

### Task 1: 定义快照契约并先锁定候选筛选规则

**Files:**
- Create: `src/shared/model-pool-sync.ts`
- Create: `src/server/services/model-pool-sync-policy.ts`
- Create: `src/server/services/model-pool-sync-policy.test.ts`

**Interfaces:**
- `BailianPoolSnapshot = { providerId: string; capturedAt: string; accountMatchConfirmed: true; quotas: BailianQuotaRecord[]; models: BailianCatalogModel[] }`。
- `BailianQuotaRecord = { model: string; type: string; remaining: number; total: number; expires: string; autoStop: boolean }`。
- `BailianCatalogModel = { model: string; name: string; provider: string; capabilities: string[]; modalities: { input: string[]; output: string[] }; features: string[]; offline?: boolean; upcomingOfflineAt?: string | null }`。
- Produces: `BailianPoolCandidate`, `BailianExcludedModel`，以及纯函数 `selectBailianPoolCandidates(snapshot, now)`。
- `selectBailianPoolCandidates` 返回 `{ candidates, excluded }`；每个 candidate 含精确 `model`、`purpose`、目录 `name`、`quotaTotalTokens`、`quotaUsedTokens`、`quotaExpiresAt`、`supportsVision`、`qualityTier: "A"`、`thinkingMode: false`、`memberType: "general"`。不执行 DB/网络/时钟副作用。

- [ ] **Step 1: 写代表目录与额度的失败测试。**

加入 fixture：一条 `Text` + `TG` + `Text → Text` + `structured-outputs` 进入 text；一条 `Vision` + `VU` + `Image → Text` + `structured-outputs` 进入 vision；一条 `Multimodal-Omni` + image 输入进入 vision；第三方作者 `deepseek`/`moonshot-ai` 只因部署在百炼目录而可匹配；含日期后缀版本必须精确匹配而不能借用 family ID 的目录能力。

加入排除断言：`Audio`/`Embedding`/未知额度类型、未配对目录、同一 model 重复目录项、`offline=true`、缺少 JSON/模态信息、缺少 `autoStop`、`autoStop=false`、零额度、负值/非整数、不合法有效期及低于 95% 本地安全线的额度不进入 candidates，并附明确排除原因。

测试至少保留以下可执行的核心断言：

```typescript
const result = selectBailianPoolCandidates(snapshot, Date.parse("2026-10-10T00:00:00+08:00"));

expect(result.candidates).toEqual([
  expect.objectContaining({ model: "chat-text", purpose: "text", quotaUsedTokens: 100_000 }),
  expect.objectContaining({ model: "chat-vision-snapshot", purpose: "vision" }),
]);
expect(result.candidates.some((item) => item.model === "chat-vision")).toBe(false);
expect(result.excluded).toEqual(expect.arrayContaining([
  expect.objectContaining({ model: "chat-vision", reason: "offline" }),
]));
```

- [ ] **Step 2: 先运行策略测试确认缺少实现。**

```powershell
npm test -- src/server/services/model-pool-sync-policy.test.ts
```

预期 FAIL，原因是候选契约/函数尚不存在，不是测试环境或数据库错误。

- [ ] **Step 3: 实现 Zod/纯函数边界。**

只接受 `Text | Vision | Multimodal` 候选额度类型；其他类型进入排除清单。日期格式先严格解析为 ISO 时间，纯日期截止按 `Asia/Shanghai` 当地日终处理；若目录提供 `upcomingOfflineAt`，以额度过期与模型下线中的较早时间作为 `quotaExpiresAt`。以 `model` 的唯一精确版本连接目录，且只有 `autoStop === true`、`remaining / total > 0.05` 时可入选。把 total-remaining 作为云端权威 used 值。

- [ ] **Step 4: 运行全部策略测试并加完整 ID 回归。**

```powershell
npm test -- src/server/services/model-pool-sync-policy.test.ts
```

预期所有边界通过；特别确认同一个 `model` 只能生成一个 purpose 候选。

---

### Task 2: 编写 Windows Bailian CLI 采集器与离线解析回归

**Files:**
- Create: `scripts/bailian-free-pool-sync.psm1`
- Create: `scripts/sync-bailian-free-pool.ps1`
- Create: `scripts/test-bailian-free-pool-sync.ps1`

**Interfaces:**
- Produces: `ConvertFrom-BailianQuotaJson -Json`，`ConvertFrom-BailianModelDetailJson -Json -ExpectedModel`，`New-BailianFreePoolSnapshot -ProviderId -QuotaJson -ModelDetails -AccountMatchConfirmed`。
- 主机脚本 accepts `-BaseUrl` 和可选 `-ProviderId`；providerId 缺省时如果恰有一个启用的百炼 provider 可用则选它，多个时交互选择，不允许隐式挑第一个。
- 脚本只发送规范化后的候选相关额度与详情，不发送 CLI 配置或原始控制台认证字段。
- HTTP 预览直接 POST `BailianPoolSnapshot` JSON 至 `/api/model-pools/bailian-free/preview`；应用 POST `{ previewId, confirmation }` 至 `/api/model-pools/bailian-free/apply`。两者遵循既有 `{ success, data, error }` envelope。

- [ ] **Step 1: 编写 PowerShell 离线解析 fixture。**

在 `scripts/test-bailian-free-pool-sync.ps1` 中内嵌成功额度 JSON、模型详情 JSON、空数组、截断 JSON、重复 model ID、缺字段/非法 quota、详情模型与请求 ID 不符等 fixture；用 `Assert-Equal`/`Assert-Throws` 普通 PowerShell 函数表达期望，不添加 Pester/npm 依赖，也不读取真实用户文件。

- [ ] **Step 2: 运行离线解析测试确认失败。**

```powershell
pwsh -NoProfile -File scripts/test-bailian-free-pool-sync.ps1
```

预期失败仅为导入函数不存在。

- [ ] **Step 3: 实现有界 CLI 收集器。**

白名单调用：

```powershell
bl usage free --all --output json --quiet
bl model list --model <validated-exact-model-id> --include-deprecated --output json --quiet
```

检查每次 `$LASTEXITCODE`；先验证 model ID 匹配 `^[A-Za-z0-9._:/-]{1,200}$` 再作为独立参数传给 CLI；按免费额度记录精确收集目录详情，不调用 `bl chat`、`bl usage freetier` 写操作或其他推理/控制台写入命令。两类响应和总模型详情均限制 500 条，超限/部分失败不发 HTTP 请求。只规范化文本/视觉相关额度，但保留耗尽与过期条目供服务端构造停用差异。

- [ ] **Step 4: 实现交互管理会话但不写磁盘。**

用 `Get-Credential` 安全提示项目账号密码；通过 `-SessionVariable`/`WebRequestSession` 让 Cookie 只留进程内存；验证 Base URL 仅为 loopback HTTP 或 HTTPS。提示操作者确认 CLI 登录账号与项目所选 provider key 属同一个百炼账户。执行登录、查询 provider 列表、展示可选择 provider 的名字/URL/脱敏 Key mask、预览与应用。密码和 Cookie 不进入 transcript/output；异常只显示 HTTP 状态和服务端脱敏错误。

- [ ] **Step 5: 添加差异确认与零候选二次输入。**

预览输出新增/更新/停用/排除总数和具体 model ID；普通差异要求输入 `APPLY BAILIAN FREE POOL`；eligible candidates 为零且会停用全部受管免费成员时要求额外输入 `STOP ALL MANAGED FREE MODELS`。输入不匹配时退出且不请求 apply。

- [ ] **Step 6: 运行 PowerShell 离线测试和语法分析。**

```powershell
pwsh -NoProfile -File scripts/test-bailian-free-pool-sync.ps1
pwsh -NoProfile -Command '$tokens=$null; $parseErrors=$null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path "scripts/sync-bailian-free-pool.ps1"), [ref]$tokens, [ref]$parseErrors) | Out-Null; if ($parseErrors.Count) { $parseErrors | Format-List; exit 1 }'
```

预期 fixture 全通过，Parser 无语法错误；不调用线上百炼或现有 LAN 服务。

---

### Task 3: 实现预览与 SQLite 原子应用服务/API

**Files:**
- Create: `src/server/services/bailian-free-pool-sync-service.ts`
- Create: `src/server/services/bailian-free-pool-sync-service.test.ts`
- Modify: `src/server/services/model-pool-admin-service.test.ts`
- Modify: `src/server/routes/model-pool-router.ts`
- Modify: `src/server/routes/model-pool-router.test.ts`
- Modify: `src/server/services/model-pool-admin-service.ts`（只移除静态 installer 导出和替换直接依赖，不顺手重构）
- Delete: `src/server/services/qianwen-free-pool-preset.ts`
- Modify: 与该 preset 相邻的既有 test，删除只断言静态常量的测试，并把行为迁移到动态策略/服务测试。

**Interfaces:**
- Produces: `previewBailianFreePool(snapshot, actorId, now)` → `{ previewId, expiresAt, changes, excluded, summary }`；`applyBailianFreePool(previewId, actorId, typedConfirmation, now)` → `{ created, updated, disabled, preservedManual, summary }`。
- Route: `POST /api/model-pools/bailian-free/preview` 与 `POST /api/model-pools/bailian-free/apply`；两个动作只授予现有 `config:manage` 能力。
- 预览 `data` 是 `{ previewId, expiresAt, changes, excluded, summary, requiresDisableAllConfirmation }`；`summary` 给出 created/updated/disabled/preservedManual/excluded 数量，`changes` 对每项保留精确 model ID、purpose、变更类型和安全原因。应用 `data` 返回 created/updated/disabled/preservedManual ID 列表及相同 summary。
- 应用请求的 `confirmation` 必须等于 `APPLY BAILIAN FREE POOL`；当预览 `requiresDisableAllConfirmation=true` 时必须等于 `STOP ALL MANAGED FREE MODELS`。
- 内存 preview Map 存规范化执行计划和基线 fingerprint，TTL 5 分钟、容量 20；重启即清空；每个操作人只能消费自己的 token。
- `listPoolMembers()` 和模型路由排序均将已启用的非默认免费模型放在已启用的付费 purpose-default 成员之前；数据库 `priority` 仍控制免费成员组内顺序。

- [ ] **Step 1: 写 service 状态转换测试。**

覆盖：创建新成员默认 `pool_enabled=0`；重复完整快照无重复行；云端额度和有效期刷新；已安装 `qianwen-free-pool` 老标记安全转为 `bailian-free-pool` 而保留数据库 ID；不符合条件或缺失模型被禁用且使用事件仍存在；手动剔除、手动禁用、失败/冷却/能力状态不会被同步重置；人工作同模型 ID 冲突时预览拒绝；两个付费默认行、凭据 ciphertext、配置、每日/月度预算和历史记录字节/字段级不变。

- [ ] **Step 2: 写预览缓存与全回滚测试。**

覆盖 provider 不存在/未启用/非 DashScope 时拒绝；未确认账号匹配时拒绝；previewId 过期、actor 不同、provider 后续停用、当前受管池 fingerprint 变化均返回冲突且不写入；同一 token 只应用一次；零候选预览显示停用数量但缺少正确 `STOP ALL...` 输入时不写入。通过测试数据库临时 `BEFORE INSERT` trigger 制造事务写入失败，断言所有 model_configs 和使用事件保持原状。

- [ ] **Step 3: 运行 service tests 确认 FAIL。**

```powershell
npm test -- src/server/services/bailian-free-pool-sync-service.test.ts
```

- [ ] **Step 4: 实现无外部副作用的差异计划与有界 Map。**

service 通过 `model-pool-policy.ts` 当前成员形态校验额度；仅管理 `preset_key IN ('qianwen-free-pool','bailian-free-pool')` 中与指定 provider 匹配的 free、非 purpose-default 成员。重复旧记录、手工撞名或用途冲突报 409。新候选按有效截止时间和 ID 排序，使用现有上限内的稳定优先级；现有成员不改管理员 priority。

生成计划时对每个旧成员采取 create/update/disable/preserve；遇到 absent/zero/expired/offline 不删除行。新 ID 用 `crypto.randomUUID()`。成功应用内的 DB 更新均包在 `db.transaction`；Preview Map 成功消费后删除，失败事务保留到 TTL，允许操作者重做全新 preview。

- [ ] **Step 5: 添加 Express 路由、能力和安全审计。**

使用 `zod` 限制 snapshot 总记录上限、字符串长度、枚举、数值和日期；route 不输出 provider secret、原始 snapshot、Cookie 或账户标识。`auditRequest` 元数据只含 provider ID、操作者、计数与 outcome。路由保留项目统一错误 envelope；不存在/过期 preview 用 404/409，schema 错误 400，权限错误走既有 401/403。

- [ ] **Step 6: 运行 service 与 router 回归。**

```powershell
npm test -- src/server/services/bailian-free-pool-sync-service.test.ts src/server/routes/model-pool-router.test.ts
```

预期原静态 install 测试已由完整动态同步契约测试替换；其它 provider/model pool route 行为继续通过。

---

### Task 4: 替换静态安装 UI 并置底付费默认成员

**Files:**
- Modify: `src/client/components/model-config/PoolView.tsx`
- Modify: `src/client/styles.css`
- Modify: `src/client/components/ModelConfigDialog.test.tsx`

**Interfaces:**
- 继续使用现有 `/api/model-pools` 列表和通用 `/api/model-pool-members/verify`；客户端不直接获取百炼配额，也不接触任何新 secret。
- UI 以稳定排序 `non-paid-default → paid-default` 展示，组内保留现有 priority 顺序。

- [ ] **Step 1: 更新组件测试先表达用户行为。**

移除对静态 “安装千问免费池” POST 的断言，新增测试：安装/更新区域显示本机 PowerShell/npm 命令和“预览后确认”的提示；不渲染可通过浏览器直接自动同步的按钮；刷新结果中普通免费成员在先，两个 `isPurposeDefault && billingMode==='paid'` 的模型行固定处于列表末尾；已有验证、剔除、恢复和编辑操作保留。

- [ ] **Step 2: 运行组件测试确认 FAIL。**

```powershell
npm test -- src/client/components/ModelConfigDialog.test.tsx
```

- [ ] **Step 3: 替换安装区域并为新模型提供显式验证提示。**

删除静态 install 请求与旧 `needsVerification` 批处理耦合；提供复制友好的本机命令 `npm run pool:sync:bailian -- -BaseUrl <local-or-https-url>`。命令应用后提示用户刷新列表，先选新成员并运行能力验证；只有验证通过才由原有操作启用。模型排序比较器把付费 purpose-default 独立固定在最后，不更改服务端返回的池数据。

- [ ] **Step 4: 运行前端目标测试和 typecheck。**

```powershell
npm test -- src/client/components/ModelConfigDialog.test.tsx
npm run typecheck
```

预期按钮请求、模型列表和其它模型池操作测试都通过；付费默认模型在桌面 UI 可见且为末尾。

---

### Task 5: 增加稳定命令、长期操作指南并执行质量闸门

**Files:**
- Modify: `package.json`
- Create: `docs/guides/bailian-free-model-pool-sync.md`
- Modify: `docs/README.md`

**Interfaces:**
- `npm run pool:sync:bailian -- -BaseUrl http://127.0.0.1:<port>` 在 Windows PowerShell 7 调起 `scripts/sync-bailian-free-pool.ps1`。
- 长期指南说明如何在管理员主机、针对明示的 LAN test URL 执行；禁止把测试步骤误用于正式版，且不记录真实用户名、密码、Key、账号 ID、额度完整清单。

- [ ] **Step 1: 给 package script 和 guide 写一致的命令。**

添加 script 映射到 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/sync-bailian-free-pool.ps1`。Guide 记录 `bl auth status` 验证登录、测试/生产的 URL 区分、CLI 查询是只读、选 provider 和同账号确认、预览差异、零候选二次确认、apply、回到 UI 验证启用新模型、失败重试和 CLI 登录失效处理。

- [ ] **Step 2: 更新索引并检查相对链接。**

在 `docs/README.md` 开发者项下同时列规格、计划和操作指南。不改写根 `README.md`，避免重复项目操作入口。运行 PowerShell `Test-Path` 检查新增的每个相对链接目标。

- [ ] **Step 3: 跑 PowerShell fixture、目标单测和全量测试。**

```powershell
pwsh -NoProfile -File scripts/test-bailian-free-pool-sync.ps1
npm test -- src/server/services/model-pool-sync-policy.test.ts src/server/services/bailian-free-pool-sync-service.test.ts src/server/routes/model-pool-router.test.ts src/client/components/ModelConfigDialog.test.tsx
npm test
```

- [ ] **Step 4: 运行剩余质量与安装闸门。**

```powershell
npm run typecheck
npm run lint
npm run build
npm run db:check
npm run smoke
npm run check:installation
```

若无 schema migration，`db:check` 仍应通过且 migration lock 不变；安装检查必须发现 PS7 入口但不要求 CLI 授权数据。任何失败要记录命令、退出码、真实原因和是否环境阻塞，不弱化测试期望。

---

### Task 6: 隔离 LAN 端到端验收与数据授权边界

**Files:** 不修改生产/日用配置；如增加一次性自动化脚本，先并入 Task 5 的测试文件范围。

**接口：** 以独立 worktree、独立 `PORT`、`DATA_DIR`、`DATABASE_PATH` 启动候选 build。只有用户明确授权的 exact test database target 可作为验收源；禁止两个进程共用 SQLite。

- [ ] **Step 1: 按项目基线建立 branch-only runtime。**

从明确选定且非正式的源环境，经 `docs/guides/backup-and-recovery.md` 记载的 repository backup/restore 流程创建并验证完整备份；在 feature worktree 的新 data directory 恢复数据库、引用文件、knowledge catalog 和匹配 managed encryption key，设置唯一 `PORT`/`DATA_DIR`/`DATABASE_PATH`。不直接复制运行中的 `app.db`，不把备份、key、恢复数据或 `.env` 纳入 Git。未获 exact target 书面确认则跳过整项，不读取或改动现有 LAN 数据。

- [ ] **Step 2: 在隔离服务运行无推理同步。**

在显式 LAN test runtime 执行 `npm run pool:sync:bailian -- -BaseUrl <isolated-test-url>`，人工确认 provider 对应及同账号关系，查看 CLI 采集摘要与服务端 preview。任何真实模型 `verify` 不自动执行；不在真实账户 quota 上触发 capability tests，除非用户另行同意实际扣减额度。

- [ ] **Step 3: 检查结果和恢复边界。**

经管理 UI 验证两个付费默认模型完全不变并置底、合格免费候选需人工验证/启用、不合格成员保留且退出活动池、使用历史仍可见。若需要最终证明 apply，应只在上一步授权的 branch-only test runtime 按差异清单交互 apply；确认审计不含秘密，核对 SQLite 事务结果和备份恢复可行性。

- [ ] **Step 4: 清理只属于本次的 branch-only runtime。**

先核对绝对路径确实位于本功能专用 `.worktrees/feat-bailian-free-model-pool-sync` 子目录；终止仅本分支启动的进程后使用 backup/recovery guide 的安全清理方式。不得递归删除原仓库、root 用户数据库、当前测试 LAN 数据或共享备份。完成时再次运行 `git status --short`，确认只包含本 Issue 代码/测试/文档，及任何此前改动清晰归属。

---

## Spec Coverage Check

| 规格要求 | 计划任务 |
| --- | --- |
| 无凭据模型额度快照和模型目录 | Tasks 1–2 |
| 精确版本/用途/能力/费用安全筛选 | Task 1 |
| Windows CLI、安全会话与预览命令 | Task 2 |
| `config:manage` 服务端预览和事务 | Task 3 |
| 旧静态数据兼容、保留历史、幂等 | Task 3 |
| 付费默认保护、置底与新模型验证提示 | Tasks 3–4 |
| CLI/权限/事务/审计及环境边界测试 | Tasks 1–6 |
| 用户文档、索引和稳定命令 | Task 5 |
