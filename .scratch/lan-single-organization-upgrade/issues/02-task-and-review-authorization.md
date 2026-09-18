# 02: 任务操作与审核权限闭环

**What to build:** 在已登录会话上交付组织共享任务数据的角色授权。操作人员可以导入和执行解析，审核人员可以处理复核和导出审核结果，只读人员只能查看；所有相关动作写入审计事件。

**Blocked by:** 01: 身份、会话与首次管理员引导

**Status:** done (2026-09-17)

- [x] 以服务端 capability 授权保护任务列表、记录详情、图片、上传、导入、解析启动/暂停/取消/重试、复核、导出和相关轮询端点；前端隐藏不可用入口但不能替代服务端校验。
- [x] 已认证用户可读取单组织共享的任务、记录和结果；文件、图片和导出下载遵循父任务/记录相同的认证授权规则。
- [x] 操作人员可导入、创建任务、执行解析生命周期和导出；审核人员可查看、提交复核和导出审核结果，但不能导入或发起解析；只读人员不能修改或导出。
- [x] 被拒绝的请求不修改任务、记录、运行或复核数据；前端在会话失效或拒绝后清理可能残留的特权状态。
- [x] 导入、任务创建、解析生命周期、复核、导出及对应拒绝操作均记录操作者、动作、目标、结果、时间和安全元数据。
- [x] HTTP 路由集成测试覆盖操作人员、审核人员、只读人员、匿名用户的权限矩阵，以及跨端点文件/图片/导出访问保护。

**实现摘要（2026-09-17）：**
- `src/shared/types.ts` 定义 `USER_CAPABILITIES`、`ROLE_CAPABILITIES` 与 `capabilitiesForRole`；`src/server/auth/capabilities.ts` 提供唯一授权入口 `requireCapability(capability, action, targetType)`，拒绝时写入 `failure` 审计（含 actor、capability、method/path、目标）并返回 403。
- `app.ts` 对任务列表/详情/记录/图片/导入/导入进度/单条与批量解析/暂停/取消/重试/复核/导出/删除/容量检查/配置读写/就绪检查逐端点声明 capability；`requireAuth` 保证匿名 401。
- 成功动作写入审计：`task.import`、`task.analyze_record/field`、`task.retry_record/field`、`task.start_analysis`、`task.pause/cancel/retry_failed`、`review.save`、`task.export`、`task.delete`，元数据仅含文件名、板块、字段、数量等安全信息。
- 角色能力：admin 全部；config = `task:view` + `config:manage`；operator = `task:view/import/analyze/delete/export`；reviewer = `task:view/export` + `review:save`；readonly = `task:view`。
- 前端：`/api/auth/me` 与登录返回 capabilities；顶栏、记录选择、解析、复核、导出、任务删除、知识库入口、配置弹窗按能力隐藏；403 广播 `notifyAccessDenied` 关闭特权弹窗并提示；只读/非复核角色文本框 `readOnly`；操作人员在模型未就绪时不再被引入模型配置弹窗。
- 测试：`src/server/auth/authorization.test.ts` 覆盖五角色 + 匿名的权限矩阵、图片/导出保护、拒绝不落库与审计内容；`src/client/auth/capability-gating.test.tsx` 覆盖操作/审核/只读/配置的前端入口显隐与拒绝清理。

