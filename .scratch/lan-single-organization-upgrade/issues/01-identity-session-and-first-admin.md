# 01: 身份、会话与首次管理员引导

**What to build:** 为单组织局域网版本建立可用的身份基础：受控首次管理员引导、管理员创建的账号、密码安全存储、登录、退出、会话失效和匿名访问拒绝。交付最小可用的登录界面与已登录用户状态，不开放自助注册。

**Blocked by:** None (can start immediately)

**Status:** done (2026-09-17)

- [x] 首次管理员只能通过主机本地命令或一次性受控配置创建；已有管理员后该入口失效，不能留下公网或局域网可重复调用的引导接口。
- [x] 密码只保存为带盐慢哈希；密码、会话标识、模型密钥和加密密钥不会出现在 API 响应、审计、日志或前端状态中。
- [x] 登录创建 `HttpOnly`、`Secure`、`SameSite=Lax` 会话 Cookie；登出、禁用账号、重置密码和会话到期均会撤销已有会话。
- [x] 除健康检查所需端点外，匿名调用现有业务 API、文件、图片和导出端点均被服务端拒绝。
- [x] 新增用户、组织、会话和必要归属字段仅通过新增迁移创建；现有业务数据保留，并以系统/未归属身份表示历史创建者。
- [x] HTTP 路由集成测试覆盖首次引导、登录成功/失败、登出、会话过期、账号停用和匿名拒绝；前端组件测试覆盖登录加载、错误和已登录状态。

**实现摘要（2026-09-17）：**
- 迁移 `016-identity-and-sessions`：`organizations`（单例 `org-default`）、`users`、`user_sessions`、`audit_events`；为任务/记录/板块/模型/知识等根表补充 `organization_id` 与 `created_by_user_id`（历史行保留 `NULL` 表示系统/未归属）。
- `src/server/auth/`：scrypt 带盐慢哈希密码、身份服务（首次引导/凭据校验/会话创建与撤销/禁用与重置即撤销）、会话 Cookie（`HttpOnly; SameSite=Lax; Secure`，`SESSION_COOKIE_SECURE=false` 仅为无 TLS 回退）、`requireAuth/optionalAuth` 中间件与登录/登出/me/status 路由，除 `/api/health` 外所有 `/api` 均需登录，`/api/ready` 需管理员。
- 引导方式：`npm run bootstrap:admin`（主机本地命令，实例锁保护，已存在账号即失效），或一次性 `FIRST_ADMIN_USERNAME/PASSWORD/DISPLAY_NAME` 环境变量（三者齐备才生效，账号存在后忽略；不写入 `.env` 白名单）。
- 前端：登录页、会话门、401 触发会话失效并清空特权状态、顶栏用户信息与退出。
- 测试：身份服务单测、auth 路由 HTTP 集成测试、迁移测试、前端登录门组件测试；更新受影响的路由/服务测试与冒烟脚本。

