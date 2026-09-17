# 架构治理进度账本

**计划：** `docs/architecture-remediation-plan-2026-09-17.md`

**最后更新：** 2026-09-17（T7 已完成；T6 eslint 仍阻塞）

## 恢复入口

- 当前任务：无
- 当前步骤：无
- 下一步：网络恢复后补 T6 的 eslint；随后 T8（实例锁与平台健壮性）
- 工作区状态：T7 已提交
- 恢复方法：读本入口 → 打开计划文档查看该任务未勾选步骤 → 继续执行，无需通读项目

## 任务计划表

状态取值：未开始 / 进行中 / 已完成 / 阻塞。

| 任务 | 状态 | 当前步骤 | 下一步 | 最近证据（命令 / 结果） | 阻塞或决策 |
| --- | --- | --- | --- | --- | --- |
| T1 迁移冻结与 catalog 单一真相源 | 已完成 | - | - | 552 项测试通过；`migrations-immutability` 红→绿→篡改即红；`npm run typecheck`、`build`、`db:check`（14/14，integrity ok）通过 | - |
| T2 模型池首启可行动 | 已完成 | - | - | 555 项测试通过；新增服务端 actions 与前端一键验证（点击前无请求、失败保留入口）；`typecheck`、`build`、`db:check`（14/14）通过 | - |
| T3 执行类型注册表 | 已完成 | - | - | `field-analysis-service.ts` 706 → 178 行；新增 `execution/` 9 个文件与 3 项注册表测试；558 项测试通过；`typecheck`、`build`、`db:check` 通过 | - |
| T4 结构化对象字段抽象 | 已完成 | - | - | 新增 `structured.ts` 工厂与探针测试；未成交/接待 5 个 handler 收敛为 3 个 definition；现有断言不改全部通过（559 项）；前台新增 `StructuredResultView` 且 DOM 不变 | - |
| T5 前端工作区分层 | 已完成 | - | - | `useWorkspaceController.ts` 484 → 117 行；新增 `useJobSelection`（273 行）、`useAnalysisActions`（174 行）、`useSectionCatalog`（22 行）；App 与 hook 测试断言不改全部通过；全量 559 项通过 | - |
| T6 质量闸门 | 阻塞 | 冒烟脚本完成；eslint 依赖安装失败 | 网络恢复后安装 eslint 并补规则集 | `npm run smoke` 通过（3 秒，可复跑，`ready:false` 符合空库预期） | npm 证书错误 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`，不绕过证书 |
| T7 文档治理 | 已完成 | - | - | 根目录 25 → 4 篇；14 篇指南移入 `guides/`，12 份一次性记录移入 `archive/`；新增 `docs/README.md` 八主题索引；README 15 处链接更新；73 份 markdown 0 失效链接 | - |
| T8 实例锁与平台健壮性 | 未开始 | - | - | - | - |

## 时间线日志

按时间倒序追加，每条格式：日期 / 任务 / 事件 / 证据。

- 2026-09-17 / T7 / 完成文档治理 / 根目录文档 25 → 4（索引、实施计划、进度账本、开发流程）；`guides/` 收纳 14 篇长期指南，`archive/` 收纳 12 份一次性记录（含 5 份根目录 task 报告）；新增 `docs/README.md` 八主题索引并更新 README 15 处链接；链接检查 73 份 markdown、0 失效
- 2026-09-17 / T6 / 冒烟脚本完成，eslint 阻塞 / 新增 `scripts/smoke-local.mjs` 与 `npm run smoke`：临时数据目录启动子进程，校验 health/静态页/ready/knowledge-sync，3 秒通过且可复跑；eslint 安装因 npm 证书错误失败，未绕过校验
- 2026-09-17 / T5 / 完成前端工作区分层 / 控制器 484 → 117 行；会话与操作令牌、轮询、刷新迁入 `useJobSelection`，分析/任务操作迁入 `useAnalysisActions`，板块字段加载迁入 `useSectionCatalog`；分页筛选复用既有 `useRecordWorkspace`；App 33 项与 hook 8 项断言不改通过；全量 559 项通过；`typecheck`、`build` 通过
- 2026-09-17 / T4 / 完成结构化对象字段抽象 / 新增 `execution/structured.ts` 工厂；未成交（归因/派生/话术）与接待质检（分析/派生）迁移为 3 个 definition；移除 2 个上下文访问器；前端新增 `StructuredResultView` 配置化渲染；探针板块测试通过；全量 559 项通过；`typecheck`、`build`、`db:check` 通过
- 2026-09-17 / T3 / 完成执行类型注册表 / `field-analysis-service.ts` 拆分为 `execution/`（registry、support、graph 与 5 个 handler 文件），调度器 706 → 178 行；`ANALYSIS_EXECUTION_TYPES` 常量派生 zod 枚举、catalog schema 与客户端选项；新增注册表测试 3 项；全量 558 项通过；`typecheck`、`build`、`db:check` 通过
- 2026-09-17 / T2 / 完成模型池首启引导 / `/api/ready` 增加 `actions.verifyPoolMemberIds`；模型池控制台显示待验证默认模型与“验证默认模型”按钮（`enablePassed: true`）；拦截提示改为“验证并启用”；新增 3 项测试；全量 555 项通过；重启服务后实机 `/api/ready` 200 且 `actions.verifyPoolMemberIds` 为空
- 2026-09-17 / T1 / 完成迁移冻结与 catalog 单一真相源 / 新增 `migrations-immutability.test.ts` 与 `migrations.lock.json`（13 个迁移）；篡改 006 后测试失败、恢复后通过；聚焦 28 项、全量 552 项测试通过；文档补充冻结规则与恢复提示
- 2026-09-17 / 计划 / 建立账本与任务计划表 / 本文件

## 决策日志

| 日期 | 任务 | 决策 | 原因 | 影响 |
| --- | --- | --- | --- | --- |
| 2026-09-17 | T7 | 长期指南移入 `docs/guides/` 子目录，而不是压缩篇数 | 安全主题本身有 4 篇长期指南，强行合并会丢失细节；根目录只留索引与活跃文档更清晰 | 计划验收改为“根目录 ≤10 篇（当前 4 篇）”，索引按 8 主题覆盖 guides 与 archive |
| 2026-09-17 | T6 | npm 安装失败时不绕过证书校验 | 项目已明确禁止放宽 TLS/证书来获得依赖 | eslint 任务保持阻塞，等待网络/证书恢复后重试 |
| 2026-09-17 | T5 | 分页/筛选/详情复用既有 `useRecordWorkspace`，不新建 `useRecordPaging` | 该 hook 已独立承担列表查询与详情请求，重命名只会制造无谓 diff | 计划文档已同步为“复用既有 hook” |
| 2026-09-17 | T4 | 探针板块以测试夹具形式验收，不落地真实板块 | 落地真实板块需要迁移、catalog 与 UI 全链路，超出抽象验收范围 | 生产接入新板块仍需在 `execution/index.ts` 增加一行 import；探针已证明无需改调度器与注册表 |
| 2026-09-17 | T3 | 执行类型字面量收敛规则：常量定义 + 每个 handler 注册一处 + 板块专属谓词（`isLostDealAttribution` 等 2 处） | 追求“活代码零字面量”会引入无意义的间接层，注册表本身就需要声明类型 | 验收口径改为“不再维护重复清单或 switch”，计划文档已同步 |
| 2026-09-17 | 全局 | 006 至 014 迁移冻结，只增不改 | 迁移 007 修改导致真实库与快照不一致 | 后续结构变更必须新增迁移 |
