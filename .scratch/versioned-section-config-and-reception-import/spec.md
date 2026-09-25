# 规格草案：板块配置版本化与接待质检新模板

**状态：** 已确认，工单已派发
**日期：** 2026-09-22

## Problem Statement

当前分析平台的板块字段、Excel 表头、提示词、知识内容和业务规则可以被直接修改，但任务没有稳定绑定“导入当时使用的配置”。配置变化后，历史任务难以复现，旧提示词和旧规则也无法直接恢复供新任务使用。

导入任务目前只选择分析板块，没有统一绑定数据平台。部分源 Excel 没有平台列，而“平台”和“会话 ID”又需要成为所有板块共有的业务字段。

接待流程质检的新 Excel 模板还改变了现有解析与导出方式：

- 只有带聊天截图的原始行需要分析。
- 截图后的空白预留行不参与分析，也不回填结果。
- 同一通会话的多个问题必须写在截图行的同一组单元格中。
- 问题、维度和扣分使用英文逗号按相同顺序连接。
- 证据说明、判定理由和优化建议需要按问题顺序组织。
- 会话 ID 需要在分析完成或进入待复核时由系统生成，并在重试中保持不变。

## Solution

为所有分析板块建立统一的配置版本和任务绑定机制。每次导入选择一个板块和一个平台，系统自动绑定该板块当前启用的已发布版本。版本固定字段、表头映射、提示词、依赖、知识内容和业务规则；历史任务始终使用导入时绑定的版本。

平台和会话 ID 作为所有板块共享的业务字段，但具体 Excel 列名由板块配置版本映射。其他字段和导出样式保持板块独立。

接待流程质检使用新的截图行契约：只分析和回填带截图的原始行，同一会话的多个问题聚合在同一单元格中，不使用预留行，不增加问题行。

接待质检采用两阶段分析：视觉模型抽取客观对话事实，统一质检模型从当前版本的问题目录中返回问题 ID、相关原文、证据和判定理由；系统再根据版本化规则本地派生维度、扣分、D 级、合计扣分、等级、优化建议和待复核状态。

## User Stories

1. As a 数据上传者, I want to select one analysis section and one platform when importing, so that the task has an authoritative business context.
2. As a 数据上传者, I want the system to show and bind the section's current published version automatically, so that I know which configuration will be used.
3. As a 数据上传者, I want files without a platform column to import normally, so that upstream templates do not need redundant metadata.
4. As a 数据上传者, I want conflicting non-empty platform cells to block the import and report rows, so that mixed-platform data is not accepted.
5. As an 管理员, I want every analysis section to support configuration versions, so that fields, prompts, knowledge, and rules can evolve safely.
6. As an 管理员, I want published versions to be immutable and permanently retained, so that historical tasks remain reproducible.
7. As an 管理员, I want to archive, restore, and reactivate a historical version, so that future imports can roll back without rebuilding configuration.
8. As an 管理员, I want existing section configurations registered as V1 automatically, so that upgrading does not require manual re-entry.
9. As an 管理员, I want to backfill a missing platform for a legacy task once, so that the task can be reanalyzed and receive a conversation ID.
10. As an 分析执行者, I want a conversation ID assigned only when a record becomes completed or needs review, so that unfinished records do not consume final IDs.
11. As an 分析执行者, I want an assigned conversation ID to remain stable across retries and exports, so that the same record keeps one identity.
12. As a 接待质检维护者, I want issue rules to include dimensions, deductions, D-level flags, and thresholds, so that model judgments produce deterministic output.
13. As a 接待质检分析员, I want one screenshot fact extraction and one unified quality judgment, so that all output fields use one consistent evidence base.
14. As a 数据导出者, I want only the task-bound section exported, so that fields from different sections are never mixed.
15. As a 数据导出者, I want multiple issues written into the screenshot row with aligned comma-separated issue, dimension, and deduction values, so that the source workbook row structure is preserved.
16. As a 数据导出者, I want no-issue rows to contain rating A, total deduction 0, review “否”, and blank issue-detail fields, so that compliant conversations do not contain filler content.
17. As a 维护者, I want real-workbook end-to-end tests and database tests for versions and conversation IDs, so that the contract is verified at user-visible boundaries.

## Implementation Decisions

### 导入任务绑定

- 一次任务只绑定一个板块、一个平台和一个配置版本。
- 导入人员选择板块和平台；系统自动绑定该板块当前启用的已发布版本。
- 导入人员不能为单次任务临时选择历史版本。
- 创建后板块、平台和版本不可修改。
- 历史任务缺少平台时，管理员可以补录一次；补录后不可修改。

### 平台字典

- 平台包含名称、全局唯一代码和启用状态。
- 名称允许修改。
- 平台代码在尚未被任务使用前可以修改；被使用后不可修改。
- 已使用平台不可删除，可以停用。
- 停用平台保留历史可见性，但不能用于新任务。

### 板块配置版本

- 所有板块统一支持草稿、已发布、当前启用和归档状态。
- 草稿可以编辑和删除。
- 发布时生成板块内递增版本号。
- 已发布版本不可修改、覆盖或删除。
- 每个板块同时只能有一个当前启用版本。
- 历史版本可以归档；恢复后才能重新启用。
- 重新启用历史版本只影响之后创建的任务，不改变既有任务。
- 版本固定字段定义、Excel 表头映射、导出设置、字段依赖、提示词、知识内容和板块业务规则。
- 模型供应商凭证、额度、冷却和运行健康状态不进入业务配置版本。
- 系统升级时，各板块当前配置登记为 V1，现有任务绑定对应 V1。

### 会话 ID

- 会话 ID 是所有板块共享的系统业务字段，不是某个板块的分析字段。
- 单条记录首次进入“已完成”或“待复核”时生成。
- 格式为平台代码 + Asia/Shanghai 派发日期 `yyyyMMdd` + 六位大写英文字母或数字随机码。
- 数据库使用全局唯一约束，碰撞时重新生成。
- 派发和状态转换必须幂等，避免并发生成多个 ID。
- 已派发 ID 在任务重试、重新分析、重新导出和状态往返时保持不变。

### 通用导出

- 一次导出只处理一个任务和该任务绑定的一个板块。
- 不提供多板块合并导出。
- 原工作簿、工作表、行、样式、图片和无关单元格保持不变。
- 目标列存在时原位回填，不存在时追加到工作表末尾。
- 平台和会话 ID 是共享业务字段，但目标列名由板块版本映射。
- 接待流程质检初始映射为 `平台 (platform_name)` 和 `会话ID (conversation_id)`。

### 接待质检导入

- 新模板首先是本板块的导入表头格式。
- 只为带聊天截图的原始行创建分析记录。
- 没有图片的预留行保持原样，不补平台、不生成会话 ID、不填写分析结果。
- 截图行结果区全部为空时创建待分析记录。
- 结果区已经完整填写时整行跳过，不覆盖，不作为模型证据。
- 结果区只填写一部分时阻止整份导入，并报告冲突行。

### 接待质检分析

- 视觉模型只执行一次截图事实抽取。
- 统一质检模型从任务绑定版本的问题目录中选择零个或多个问题 ID。
- 模型为每个问题返回相关聊天原文、证据说明和判定理由。
- 维度、扣分、是否 D 级、合计扣分、等级、建议和待复核状态由版本化规则本地派生。
- 模型不能创建未配置问题，也不能临时改变扣分和维度。
- 不能从截图可靠确认的规则不得强行判定。
- 当前程序中的问题判定条件、扣分和等级规则作为接待质检首个新版本的初始口径。
- 参考结果文件只用于理解字段含义和表达形式；与当前程序冲突的示例规则不覆盖程序规则。
- 每条启用问题规则必须配置维度；缺少维度时禁止发布版本。

### 时间和对话轮数

- 会话开始时间只有在截图中可靠识别出完整日期和时间时填写。
- 无法可靠识别时留空并标记待人工复核，不使用业务日期或导入时间推算。
- 客户和人工客服的一次完整往返算一轮。
- 客户连续发送多条消息后人工客服回复一次，算一轮。
- 会话末尾只有客户消息而未收到人工客服回复时，不算完整一轮。
- 机器人和系统消息不算人工客服回复。

### 接待质检截图行回填

- 导出只修改带截图的原始行。
- 不使用截图后的预留行，也不新增问题行。
- 多个问题按稳定顺序写入同一单元格。
- `问题`、`维度`、`扣分`分别使用英文逗号 `,` 连接，并保持一一对应的相同顺序。
- `合计扣分`填写所有问题扣分的总和。
- `是否D级`按会话聚合：任一问题为 D 级时填“是”；存在问题但都不是 D 级时填“否”；没有问题时留空。
- `证据说明`和`判定理由`按问题顺序使用 `1.`、`2.` 编号换行。
- `聊天原文`只保留与识别问题有关的原文片段，去重后合并在一个单元格中，不逐问题编号。
- `优化建议`按问题顺序编号换行，相同建议去重。
- 没有问题时，聊天原文、证据说明、判定理由和优化建议全部留空。
- 没有问题且信息充分时，等级为 A、合计扣分为 0、是否待人工复核为“否”。
- 信息不足但没有可确认问题时，不虚构问题，是否待人工复核为“是”。

## Testing Decisions

最高价值测试缝已经确认：

1. 使用真实接待质检 XLSX 导入。
2. 选择接待流程质检板块和平台。
3. 断言任务绑定当前已发布配置版本。
4. 使用受控视觉和质检模型结果执行分析。
5. 让记录进入已完成或待复核状态并派发会话 ID。
6. 导出工作簿。
7. 重新读取并检查截图行回填、多问题英文逗号顺序、编号换行、空白预留行、图片、样式和追加/原位列。

数据库集成测试覆盖：

- 每板块唯一当前启用版本；
- 已发布版本不可变；
- 版本递增、归档、恢复和重新启用；
- 平台代码唯一和使用后不可修改；
- 会话 ID 全局唯一、碰撞重试和并发幂等；
- 现有配置和任务迁移到 V1；
- 历史任务平台补录后锁定。

规则纯函数测试覆盖：

- 问题 ID 到维度、扣分和 D 级映射；
- 多问题总扣分；
- D 级覆盖；
- 等级阈值；
- 无问题输出；
- 多值字段顺序和英文逗号序列化；
- 缺少维度和非法依赖时禁止发布。

## Out of Scope

- 一次任务导入或导出多个板块。
- 导入人员为单次任务选择任意历史版本。
- 原地修改已发布版本。
- 发布新版本后自动重算历史任务。
- 自动猜测历史任务的平台。
- 将无截图预留行作为独立分析记录。
- 在最终导出中为多个问题新增行。
- 把已有 Excel 结果作为模型证据。
- 版本化模型凭证、额度、冷却和健康状态。

## Further Notes

- 平台和会话 ID 是全板块共有字段；其他字段保持板块独立和灵活。
- 接待流程质检是第一套采用新配置版本和新 Excel 行契约的板块，但版本能力面向全部板块。
- 本草案不考虑 #390，也不修改任何外部 GitHub Issue。
- 规格确认后，下一步才进入 `$to-tickets`，拆分可独立验收的实施工单及阻塞关系。
