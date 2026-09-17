# 架构与结构性重复治理实施计划

**日期：** 2026-09-17

**依据：** 2026-09-17 项目体量与架构评审（生产代码约 138 文件 / 15.6k 行，测试约 72 文件 / 13.6k 行 / 549 用例，运行时依赖 10 个）。

本文件是 `docs/stability-development-workflow.md` 的后续：稳定性阶段已基本完成，本阶段处理结构性问题，不重复已完成的可靠性内容。

## 目的

在不新增业务功能的前提下，消除三处结构性重复（执行类型分支、板块管线、配置双真相源），收紧工程质量闸门，让“新增一个板块”从复制粘贴变为声明式扩展。

## 进度记录与恢复

本计划的进度不依赖任何会话记忆，全部落在仓库文件里，分两层：

1. **本文件**：每个任务的“实施顺序”是复选框，完成即勾选，提供步骤级进度。
2. **进度账本** `docs/architecture-remediation-progress.md`：记录当前任务、当前步骤、下一步、验证证据、决策与阻塞，提供恢复入口。

更新规则：

- 开始任务前：账本登记“进行中”并写清当前步骤与下一步；恢复入口同步更新。
- 每完成一步或一次验证：更新账本的“下一步”与“证据”，证据必须含命令与结果。
- 任务完成：勾选本文件对应步骤，账本登记“已完成”，再提交。
- 中断恢复流程：打开本文件看勾选进度 → 打开账本看“恢复入口”→“下一步” → 继续，无需重新通读项目。
- 账本与代码在同一提交序列内提交，禁止长期只存在于工作区。

## 已确认的问题与证据

1. **执行类型分支分散**
   `reception_quality_analysis`、`lost_deal_attribution` 等字面量出现在 6 个活代码文件：`src/shared/types.ts`、`src/server/security/configuration-input.ts`、`src/server/services/knowledge/knowledge-sync-service.ts`、`src/server/services/field-analysis-service.ts`、`src/server/services/field-config-service.ts`、`src/client/components/FieldConfigEditor.tsx`，另有 4 个历史迁移。新增类型要同时改 6 处，漏一处即运行期报错。
2. **板块管线复制式生长**
   `field-analysis-service.ts` 706 行、8 种执行类型，`runAiField`、`runLostDealAttribution`、`runReceptionQualityAnalysis` 三套“调模型 → 写 run → 错误快照”流程近似复制；未成交与接待质检各自带 parse/derive/rules 与前端渲染，共享面几乎为零。
3. **配置双真相源**
   `knowledge/catalog.json`（3520 行）与迁移 `006` 至 `013` + `src/server/db/seed.ts` 同时定义字段与知识库结构。2026-09-17 启动冲突是直接后果：迁移 `007` 在本地库已记录应用后被修改，真实库缺失元数据而文件里有，只能靠 `npm run knowledge:restore` 修复。迁移在此批次开发期被修改，属于发布前可接受、发布后不可再犯的操作。
4. **模型池首启不可用**
   迁移 `014` 生成的成员 `pool_enabled=0` 且能力状态 `untested`，`/api/ready` 返回 503，页面没有可执行引导，只能靠终端调接口验证。本次会话即手动执行了 `verify + enablePassed`。
5. **前端控制器膨胀**
   `useWorkspaceController.ts` 484 行；`useRecordWorkspace.ts` 285 行。组合层同时承担任务选择、板块加载、分页、分析控制与复核保存。
6. **质量闸门缺失**
   无 `lint` / `format` 脚本与配置；测试全部为 jsdom 单测与进程内集成，没有端到端冒烟；`tsc strict` 是唯一静态闸门。
7. **文档报告 sprawl**
   `docs/` 35 篇，根目录另有 5 份 `task-*-report.md`，大量为一次性实施与验收记录，缺少入口索引。
8. **平台绑定**
   实例锁端口为 `30000 + sha256(path) % 20000`，本次会话与无关软件 `ROGLiveService.exe`（端口 49719）冲突，报错信息无法区分“同库实例”与“无关占用”。

## 实施原则

1. 零行为变化优先：前三阶段以等价重构为主，公开字段 key、状态语义、Excel 表头和知识库名称不变。
2. 先测试后实现：每个任务先补失败测试或 golden 测试，再改生产代码。
3. 迁移不可变：`006` 至 `014` 自本文件生效起冻结，只允许新增迁移，不允许修改已应用的迁移文件。
4. 不新增运行时依赖；质量闸门只允许增加开发依赖，且 lock 变更必须单独提交。
5. 每项任务一个提交序列，可单独审查与回退。

## 非目标

- 不引入 ORM、前端状态库、React Query、monorepo、微服务。
- 不重写 UI 与样式，不改动任何公开 Excel 列。
- 不调整执行语义：模型调用次数、预算、复核与取消规则保持不变。
- 不为假想的多人/多实例需求做设计。

## 阶段一（P0）：阻断结构性恶化

### T1 迁移冻结与 catalog 单一真相源

**实施顺序**

- [x] 新增 `src/server/db/migrations/migrations-immutability.test.ts`：对 006 至 014 源文件计算 sha256 并与仓库内基线文件比对；基线文件初始记录当前哈希，后续新增迁移必须在同一提交中追加基线。
- [x] 在 `docs/guides/database-migrations-and-recovery.md` 与 `docs/guides/knowledge-sync-recovery.md` 写明：结构变更只能走“新增迁移”；`knowledge/catalog.json` 定位为导出快照与恢复源，禁止手工编辑已提交快照。
- [x] `npm run knowledge:restore` 输出补充提示：将覆盖本地知识配置、备份位置与适用场景。
- [x] 在临时库验证：手工改快照后启动应按既有冲突流程拦截，不静默覆盖。

**验收标准**

- 迁移哈希测试通过，且修改任一冻结迁移即测试失败。
- 文档明确规则后，仓库内不再出现“迁移被修改”的提交。
- 冲突路径行为与 `docs/guides/knowledge-sync-recovery.md` 描述一致。

### T2 模型池首启可行动

**实施顺序**

- [x] `/api/ready` 在 503 时基于 `modelChecks` 附加 `actions` 字段（待验证成员 ID 列表与建议动作），不新增接口。
- [x] 前端就绪提示旁增加“验证默认模型”按钮，复用 `POST /api/model-pools/qianwen-free/verify`（`enablePassed: true`），显示逐个结果；验证必须由用户点击触发，不自动调用模型。
- [x] 模型池控制台在存在“已配置凭据但未入池”的成员时显示一次引导说明。

**验收标准**

- 新数据库或迁移完成后，页面无需终端命令即可完成验证并使 `/api/ready` 返回 200。
- 组件测试覆盖“未验证 → 触发验证 → 就绪”路径与失败提示。
- 不产生任何后台自动验证请求。

## 阶段二（P1）：消除结构性重复

### T3 执行类型注册表

**实施顺序**

- [x] 新增 `src/server/services/execution/`：`registry.ts` 定义 `FieldExecutionHandler`，包含 `type`、`dependencies`、`validate`、`run(ctx)`、`derive?`、`status(result)`。
- [x] 将 8 种执行类型迁移为独立 handler 文件（`ai.ts`、`knowledge-match.ts`、`knowledge-extract.ts`、`lost-deal.ts`、`reception-quality.ts`）；`field-analysis-service.ts` 只保留字段图执行、预算、重试与聚合，目标不超过 200 行。
- [x] `src/shared/types.ts` 导出 `ANALYSIS_EXECUTION_TYPES` 常量，`configuration-input.ts` 的 zod 枚举、catalog schema 枚举、`field-config-service.ts` 校验与客户端下拉全部由该常量派生。
- [x] 前端按注册表渲染类型专属设置面板，替换 `FieldConfigEditor.tsx` 中的类型分支，保留现有 DOM 结构与 aria 语义。

**验收标准**

- 现有 549 项测试断言不变全部通过；`typecheck`、`build` 通过。
- 新增“未注册执行类型返回明确错误”与“新增类型不需修改调度器”的注册表测试。
- `field-analysis-service.ts` 不超过 200 行；执行类型清单与分派集中在 `ANALYSIS_EXECUTION_TYPES` 常量与 `execution/` 注册表（每个 handler 只在注册处声明自身类型一次，不再维护重复清单或 switch）。

### T4 结构化对象字段抽象（板块管线泛化）

**实施顺序**

- [x] 定义 `StructuredFieldDefinition`：`{ key, sources, parse(raw, ctx), derive(parsed), status(result), exportFields }`。
- [x] 未成交（归因、派生、话术）与接待质检（质检分析、派生）迁移到同一抽象；业务规则文件（`lost-deal-script-rules.ts`、`reception-quality-rules.ts`）保持独立，只抽象流程不抽象内容。
- [x] 前端抽取 `StructuredResultView`，板块差异用配置声明，替换 `App.tsx` 中的专用渲染分支。
- [x] 用探针验收：新增一个最小结构化板块，只允许 1 个迁移 + 1 个规则文件 + 1 个 definition 文件。

**验收标准**

- 两个板块的解析、派生、状态与导出 golden 测试结果与重构前逐字节一致。
- 探针板块集成测试通过，且未修改 `field-analysis-service.ts` 与注册表文件。
- 不修改任何公开字段 key 与 Excel 表头。

## 阶段三（P2）：工程与文档

### T5 前端工作区分层

- [x] 将 `useWorkspaceController.ts` 拆分为 `useJobSelection`（任务与会话、操作令牌、刷新与轮询）、`useSectionCatalog`（板块/字段加载）、`useRecordWorkspace`（分页/筛选/详情，已存在故复用）与 `useAnalysisActions`（启动/暂停/取消/重试）。
- [x] 组合层只负责 hook 装配、header 测量与任务板块同步，控制在 150 行以内。

**验收标准**

- `App.test.tsx` 与现有 hook 测试断言不改全部通过。
- 切换任务不显示上一任务记录、卸载取消请求等既有行为由测试覆盖。
- `useWorkspaceController.ts` 不超过 150 行。

### T6 质量闸门

- [x] 增加静态 lint 闸门与 `npm run lint`：`typescript-eslint` 全系列 peer 均要求 `typescript <6.1`，项目使用 TypeScript 7，改用 `oxlint`（原生支持 TS 与 react-hooks）；最小 error 规则为 `react-hooks/rules-of-hooks`，其余历史告警保持 warn；lock 变更单独提交。
- [x] 新增 `scripts/smoke-local.mjs`：用临时 `DATA_DIR` / `DATABASE_PATH` 启动服务子进程，验证 `/api/health`、静态页面与 `/api/ready` 的预期状态；不调用任何模型；纳入发布流程文档。

**结果（2026-09-17）**

- 安装依赖时 npm 报证书失败；确认 `registry.npmjs.org` 为直连且证书链为公共 CA 后，用“公司 CA + Node 公共根证书”合并信任文件完成安装，`strict-ssl` 始终保持开启，未放宽校验。
- `npm run lint`：0 error；历史告警保留为 warn，未批量修改业务代码。
- lint 暴露 1 处真实问题并修复：`SectionConfigDialog` 在提前 `return null` 之后调用 `useCallback`（条件 Hook），已把回调移到 return 之前；相关页面测试断言不变通过。
- 闸门有效性验证：临时注入条件 Hook 后 lint 报错并以退出码 1 失败，移除后恢复 0。
- 冒烟脚本 3 秒通过且可复跑，不调用模型。

**验收标准**

- `npm run lint` 0 error；不因 lint 批量修改业务代码。
- 冒烟脚本在干净依赖环境 30 秒内完成并可复跑。

### T7 文档治理

- [x] 根目录 5 份 `task-*-report.md` 与一次性验收记录移入 `docs/archive/`（共 12 份）。
- [x] 长期指南移入 `docs/guides/`（14 份），根目录只保留索引、活跃计划与流程。
- [x] 新增 `docs/README.md` 索引，按启动、配置、同步、迁移、备份、维护、安全、模型池 8 个主题组织。
- [x] 后续文档统一使用“目的 / 实施顺序 / 验收 / 回退”模板，不再新增流水账式报告。

**验收标准**

- `docs/` 根目录文档不超过 10 篇（当前 4 篇：索引、实施计划、进度账本、开发流程），每篇可从索引到达。
- 仓库内无失效相对链接（73 份 markdown，0 处失效）。

### T8 实例锁与平台健壮性

保持确定性端口（换端口会破坏“同库互斥”语义），只改善诊断与文档：

- [x] 占用冲突时补充诊断：Windows 下解析占用进程并提示“可能是其他数据库实例或无关软件占用”。
- [x] `docs/guides/local-access-and-startup.md` 补充确认与处置步骤。
- [x] 新增“端口被占用时错误信息包含端口与排查建议”的测试；测试统一使用随机临时路径。

**验收标准**

- 报错可直接定位问题来源。
- 同一数据库并发启动仍被拒绝，锁语义不变。

## 顺序与依赖

1. T1、T2 互不依赖，先做，分别阻断数据风险和首启不可用。
2. T3 独立于 T4；T4 依赖 T3 的注册表。
3. T5 至 T8 互不依赖，可与 T3/T4 并行。
4. 每个任务完成后单独验证并提交，禁止跨任务混提。

## 全局验收基线

每个任务合并前执行：

```powershell
npm run typecheck
npm test
npm run build
npm run db:check
```

硬性约束：

- 006 至 014 迁移不再修改；
- 不新增运行时依赖；
- 公开 Excel 列、字段 key、知识库名称与状态语义不变。

## 风险与回退

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 重构改变隐藏语义 | 分析结果回归 | 先做 golden 测试逐字节对比；一次只迁移一个板块 |
| 迁移哈希测试阻碍正当修复 | 无法修改历史迁移 | 允许显式更新基线并在提交信息记录原因，视为发布级变更 |
| eslint 历史告警过多 | 拖慢节奏 | 只启用最小 error 规则，其余 warn |
| T4 抽象过度 | 抽象泄漏、复杂度转移 | 以第三个板块为探针，不达标则退化为“共享解析、独立派生” |
| 实例锁诊断依赖系统命令 | 诊断缺失 | 命令失败时退回现有文案，不影响启动判断 |

## 度量目标

| 指标 | 现状 | 目标 |
| --- | --- | --- |
| `field-analysis-service.ts` | 706 行 | 不超过 200 行 |
| `useWorkspaceController.ts` | 484 行 | 不超过 150 行 |
| 执行类型清单与分派 | 6 个活代码文件各自维护 | 常量派生 + 注册表注册（每类型一处） |
| 新增板块改动面（评估） | 约 8 个文件 | 不超过 3 个文件 + 1 个迁移 |
| `docs/` 根目录文档 | 35 篇 | 根目录 4 篇 + `guides/` 14 篇 + `archive/` 12 篇 |
| 质量闸门 | 无 lint、无冒烟 | `npm run lint` 0 error + 可复跑冒烟 |
