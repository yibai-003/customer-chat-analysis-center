# 配置化板块与普通字段实施计划

> 关联工单：GitHub Issue #11
> 工作分支：`feature/config-driven-sections`
> 约束：不提交、不合并、不修改本地 `main` 或用户已有未提交文件。

## 实施原则

- 每个行为切片先补回归测试，再写最小实现。
- 配置版本是唯一的业务配置边界；实时表只作为旧数据初始化和兼容入口。
- 普通字段走通用执行器；复杂业务走已注册执行器。
- 不新增“第几个字段”的特殊逻辑，也不把字段数量写死在接口或界面中。
- 不读取 `.env`、数据库、备份、密钥或真实业务文件。

## 工作单元

### 1. 固化共享契约和版本校验

目标：为通用导入契约、字段级输入来源和完整草稿保存建立稳定类型。

预计文件：

- `src/shared/types.ts`
- `src/server/security/configuration-input.ts`
- `src/server/services/section-config-version-service.ts`
- `src/server/services/section-config-version-service.test.ts`

内容：

- 增加通用版本导入契约类型，兼容已有接待质检专用契约。
- 为普通字段增加可选的外部输入来源配置（如代码库现有命名为准），默认使用板块配置输入。
- 去除字段快照和通用导出列的应用层固定数量上限；保留单项长度、嵌套深度和资源限制。
- 发布时校验导入契约、截图列、必需/可选输入表头、字段输入来源、执行器和导出列。
- 让旧版本缺少通用契约时能够生成兼容默认值。

测试：

- 可保存和发布大于旧数组限制的普通字段集合。
- Key 稳定、依赖循环、缺失依赖、未注册执行器和非法导出列仍被拒绝。
- 接待质检版本原有专用校验继续通过。

### 2. 草稿版本的完整编辑服务

目标：让配置界面一次提交完整草稿快照，并防止导入过程回写实时配置。

预计文件：

- `src/server/services/section-config-version-service.ts`
- `src/server/services/section-config-version-service.test.ts`
- `src/server/app.ts`
- `src/server/auth/configuration-admin.test.ts`

内容：

- 草稿创建基于当前发布版本；首次创建基于现有实时配置初始化。
- 统一 PATCH 保存板块快照、字段快照、导入契约、依赖和导出设置。
- 发布校验通过后冻结版本；历史版本不能被实时表覆盖。
- 保留旧字段/板块接口用于兼容，但新增界面不再用它们保存版本配置。
- 补充审计元数据，保持现有权限边界。

测试：

- 草稿完整更新具有事务性，非法快照不会留下部分写入。
- 新发布版本只影响后续任务，旧任务仍读取旧版本。
- 配置人员和管理员可管理；其他角色仍不可写。

### 3. 通用版本导入预览与导入

目标：使用选定版本校验工作簿，不再把外部表头写回实时板块。

预计文件：

- `src/server/services/excel-import-service.ts`
- `src/server/services/streaming-xlsx-import-service.ts`
- `src/server/services/import-worker.ts`
- `src/server/db/repositories.ts`
- `src/server/services/excel-import-preview.test.ts`
- `src/server/services/streaming-xlsx-import-service.test.ts`
- `src/server/services/excel-import-service.test.ts`

内容：

- 预览和导入参数统一携带 `sectionConfigVersionId`。
- 从版本快照解析通用导入契约；必需列缺失返回明细，可选列缺失填空，额外列只进入记录上下文。
- 删除或隔离通用导入中的 `mergeSectionSourceFields` 回写路径。
- 保留唯一截图记录边界、上传安全、磁盘预留、失败清理和流式导入。
- 保持接待质检版本化导入契约、历史结果冲突和 WPS 图片锚点兼容。

测试：

- 通用板块预览能区分缺失必需列和缺失可选列。
- 实际导入不改变 `analysis_sections.source_fields_json`。
- 预览版本与导入版本不一致时拒绝导入。
- 每个截图只创建一条记录，额外列仍能在记录上下文读取。
- 接待质检导入回归测试全部通过。

### 4. 通用字段执行上下文

目标：让普通 AI 字段严格按版本配置读取截图、外部输入和字段依赖。

预计文件：

- `src/server/services/execution/` 下通用 AI 执行器及支持模块
- `src/server/ai/field-prompt-builder.ts`
- 对应 `*.test.ts`

内容：

- 使用任务绑定版本中的字段和输入来源构建上下文。
- 图片只有在字段 `imageEnabled` 为 `true` 时发送。
- 依赖字段按拓扑顺序执行；失败字段按现有规则影响下游，不绕过专用执行器。
- 保持敏感运行态不进入版本快照。

测试：

- 新增普通 AI 字段默认不发图片；显式开启后才发图片。
- 字段输入来源和依赖结果可被提示词读取。
- 未成交和接待执行器不被通用逻辑替代。

### 5. 按版本导出

目标：导出列和行模式完全由任务绑定版本控制。

预计文件：

- `src/server/services/section-export-settings.ts`
- `src/server/services/excel-export-service.ts`
- `src/server/services/excel-export-service.test.ts`
- `src/server/services/section-config-version-service.test.ts`

内容：

- 通用草稿生成导出列；字段 `exportEnabled` 控制默认列。
- 运行时不从当前实时字段补列。
- 保持基础平台、会话 ID列和接待质检专用结构化导出格式。
- 校验导出 Key、目标表头和字段来源的一致性。

测试：

- 草稿新增/删除/改名普通字段后，发布版本导出列准确变化。
- 历史任务导出仍使用历史版本列。
- 接待质检截图记录导出不回归。

### 6. 配置界面改为版本编辑器

目标：配置人员在草稿中完成板块、输入、字段、导出和发布操作。

预计文件：

- `src/client/components/SectionConfigDialog.tsx`
- `src/client/components/FieldConfigEditor.tsx`
- `src/client/components/admin/SectionVersionManagementDialog.tsx`
- `src/client/components/admin/SectionVersionManagementDialog.test.tsx`
- `src/client/components/FieldConfigEditor.test.tsx`
- 必要时新增 `src/client/components/admin/SectionDraftEditor.tsx`

内容：

- 打开配置时展示当前发布版本和草稿状态。
- 创建草稿后在本地编辑完整快照，保存调用版本 PATCH；不再逐条调用字段实时 CRUD。
- 字段目标表头改变时不自动改变 `key`；新字段生成唯一 Key，用户可显式编辑。
- 新增普通 AI 字段时图片解析默认关闭。
- 输入契约支持必需/可选列，导出设置可编辑；保留窄屏、加载、空态、错误和权限状态。
- 接待质检专用规则编辑入口继续可用。

测试：

- 编辑字段标签不改变 Key。
- 默认图片开关关闭，显式开启可保存。
- 草稿保存、发布和错误提示覆盖主要交互。

### 7. 全量回归和交付检查

预计文件：

- 仅在发现问题时修改对应实现或测试文件。

执行顺序：

1. 运行各工作单元的聚焦 Vitest。
2. 运行 `npm test`、`npm run typecheck`、`npm run lint`、`npm run build`。
3. 运行 `npm run db:check`、`npm run smoke`、`npm run check:installation`。
4. 如果接待质检相关文件发生变化，运行 `npm run test:reception-xlsx` 和 `npm run gate:reception-xlsx`。
5. 检查 `git diff` 与 `git status`，确认没有触碰用户已有的 `AGENTS.md`、`docs/guides/project-operations.md`、`knowledge/catalog.json` 改动，也没有生成敏感或真实业务工件。

## 风险与回退

- 如果现有实时配置接口被其他页面依赖，保留接口并增加兼容测试，不直接删除。
- 如果历史版本缺少新字段，使用读取时默认值，不重写历史 JSON。
- 如果通用导入和接待专用导入存在同名参数，优先按板块版本业务规则分派。
- 如果需要新增数据库字段，必须追加有序迁移并同步迁移锁；优先使用现有 JSON 快照避免不必要迁移。
- 任何真实运行数据验证必须使用经过授权的完整备份恢复到独立 `DATA_DIR`，本实现阶段不连接日常数据库。
