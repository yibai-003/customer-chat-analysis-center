# 09: 审计追踪与管理操作界面

**What to build:** 为所有受认证请求建立稳定的请求关联标识，并提供管理员可使用的审计与备份管理界面，使账号、配置、任务、模型池、备份和权限拒绝可以从用户操作追溯到服务端事件。

**Blocked by:** None (can start immediately)

**Status:** done (2026-09-17)

- [x] 服务端接受格式合法的 `x-request-id`；请求未提供时自动生成不可预测的关联 ID，并通过响应头返回。
- [x] 同一请求产生的成功或拒绝审计事件使用同一个关联 ID；登录成功、登录失败、账号管理、配置、模型池、任务、复核、导出和备份恢复均不得无故留空。
- [x] 非法、过长或包含控制字符的外部请求 ID 被拒绝或替换，不能写入响应拆分字符、日志控制字符或不受限审计数据。
- [x] 只有具备 `audit:view` 的管理员可以进入审计界面，按动作、操作者、目标、结果和时间范围筛选，并使用现有游标分页继续加载。
- [x] 审计详情显示关联 ID、安全元数据和事件时间，不显示密码、Cookie、会话哈希、模型 API Key、加密密钥或完整敏感文件路径。
- [x] 只有具备 `backup:manage` 的管理员可以查看备份列表并创建备份；恢复操作明确要求新目录、二次确认和恢复后验证，不能覆盖运行数据目录。
- [x] 页面区分“备份包已生成”“恢复副本已生成”和“恢复副本验证通过”，不得把创建副本误报为已经切换生产数据。
- [x] HTTP 集成测试覆盖关联 ID 自动生成/透传/校验、审计事件关联、敏感信息排除和权限拒绝；前端测试覆盖筛选分页、备份创建、恢复确认与错误状态。

**实现摘要（2026-09-17）：**
- 新增 `src/server/auth/correlation.ts`：全局中间件最先执行；合法 `x-request-id`（`[A-Za-z0-9._:@+-]`，≤128）原样透传，缺失/非法/过长/列表或非 ASCII 值替换为 `randomUUID`，统一写入响应头与 `req.correlationId`，从源头避免响应拆分与日志注入。
- 关联贯通：`auditRequest`、`requireCapability` 拒绝审计、登录成功/失败（`verifyCredentials`）、登出（`revokeSession`）、账号管理（`actorFrom`）全部使用 `req.correlationId`；CLI/引导无请求时保持为空。
- 新增 `POST /api/admin/backups/verify`（`backup:manage`）：调用 `verifyRestoredEnvironment`，校验数据库版本/完整性、引用文件、知识快照与密钥可用性，写 `backup.verify` 审计（成功/失败结果不同 outcome），并拒绝运行数据目录内的目标。
- 前端：`AuditLogDialog.tsx`（审计日志：动作/操作者/目标/结果/时间筛选、游标“加载更多”、事件详情含请求 ID 与安全元数据）；`BackupManagementDialog.tsx`（备份列表与创建、恢复到新目录 + 二次确认、验证恢复副本并逐项展示检查结果，明确区分“备份包已生成 / 恢复副本已生成（尚未切换运行数据）/ 验证通过”且提示切换由主机侧人工执行）；顶栏按 `audit:view`、`backup:manage` 显示入口，`useWorkspaceController` 对话框状态扩展。
- 测试：`correlation.test.ts` 6 项（自动生成、透传、非法替换、拒绝关联、登出关联、备份验证权限与关联）；`AuditLogDialog.test.tsx` 4 项；`BackupManagementDialog.test.tsx` 6 项；`capability-gating.test.tsx` 增加三处管理入口显隐断言。全量 87 文件 / 657 项测试、类型检查、lint、构建与冒烟通过；并在运行中的服务上端到端复核（生成/透传/验证接口/审计关联）。

