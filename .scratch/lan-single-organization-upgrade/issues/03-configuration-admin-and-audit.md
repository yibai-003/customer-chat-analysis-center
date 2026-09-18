# 03: 配置、模型池与账号管理权限及审计

**What to build:** 交付管理员账号管理、配置人员的板块/字段/知识库/模型池操作权限，以及可追溯的管理与配置审计。将现有模型池验证、剔除和效能相关敏感入口纳入统一授权边界。

**Blocked by:** 01: 身份、会话与首次管理员引导

**Status:** done (2026-09-17)

- [x] 管理员可创建、分配角色、启用、停用和重置内部账号；非管理员无法调用这些操作。
- [x] 配置人员可管理板块、字段、知识库、模型配置和模型池；操作人员、审核人员和只读人员的服务端请求被拒绝。
- [x] 管理员拥有全部配置权限，并且模型池验证、剔除、恢复、模型凭据更新和备份/恢复等高影响操作均要求明确 capability。
- [x] 配置读写、模型池操作、账号管理、备份恢复与权限拒绝均产生不可变审计事件；审计查询仅向管理员开放。
- [x] 审计事件包含 actor、动作、目标类型/ID、成功或拒绝、时间、请求关联标识和安全元数据，不保存密码、会话或 API Key。
- [x] HTTP 路由集成测试覆盖五类角色对代表性配置、模型池、账号、审计和备份恢复端点的完整权限矩阵。

**实现摘要（2026-09-17）：**
- 迁移 `017-immutable-audit-events`：重建 `audit_events`（actor 不再外键，允许账号删除后保留历史操作者），新增 `audit_events_immutable_update/delete` 触发器，存储层拒绝修改与删除；`db:check` 通过（版本 17、外键 0）。
- capability：新增 `user:manage`、`backup:manage`（admin 全部；config 仅 `task:view`+`config:manage`），保留 `audit:view`。
- 账号管理 `src/server/routes/admin-router.ts`：`GET/POST /api/admin/users`、`PATCH /api/admin/users/:id`（角色/启用/显示名）、`POST .../reset-password`，全部 `user:manage`；身份服务改为显式 actor 审计并新增 `updateUser`，禁止停用或降级最后一个启用中的管理员，停用/重置仍即时撤销会话。
- 审计查询 `GET /api/admin/audit-events`（`audit:view`）：按 action/actor/target/outcome/时间过滤，游标分页，仅返回安全字段。
- 备份恢复 HTTP 入口（`backup:manage`）：`GET/POST /api/admin/backups` 与 `POST /api/admin/backups/restore`（新目录恢复、禁止写入运行数据目录、路径穿越校验），成功写入 `backup.create`/`backup.restore` 审计。
- 配置审计：板块/字段/模型配置写入、知识库导入与条目增删改、模型池服务商创建/凭据更新/预设安装/验证/剔除/恢复/设置更新均写入成功审计；`x-request-id` 写入事件关联标识；模型 API Key 只记录字段名，不记录值。知识库路由整体纳入 `config:manage`。
- 测试：`src/server/auth/configuration-admin.test.ts` 覆盖五角色+匿名的账号/配置/模型池/审计/备份权限矩阵、越权不落库、最后管理员保护、凭据与密码不入审计；同步调整既有审计清理方式以适配不可变日志；`smoke-local.mjs` 增加匿名管理接口拒绝与管理员审计查询校验。

