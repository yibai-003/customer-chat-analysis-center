# 局域网单组织多用户版本规格

**日期：** 2026-09-17  
**状态：** 实施就绪草案  
**架构决策：** [ADR-0001](../../docs/adr/0001-lan-single-organization-access-model.md)

## Problem Statement

客服解析中心当前以本机单人模式运行：服务、SQLite 数据、上传文件、模型配置和任务操作均没有用户身份、权限、审计或受控部署边界。将其直接暴露到局域网会导致任何能访问地址的人都可操作任务、查看记录、修改模型和知识配置，且没有可追溯性。

目标是在暂不具备服务器和公网部署条件时，交付可在一台固定局域网主机上稳定运行的单组织多人版本。该版本必须支持管理员创建账号、五类角色授权、组织内共享数据、审计、备份恢复、镜像化运行和自动质量闸门，并为未来公网部署和服务型数据库迁移保留演进空间。

## Solution

系统运行在一台受控的局域网主机上，以内部 HTTPS 地址供组织内用户访问。所有业务请求均要求已登录会话；服务端根据用户角色授权，记录敏感操作的操作者和结果。

首期组织模型固定为一个组织：

- 已授权用户可以查看组织内共享的任务、记录和解析结果。
- 任务、导入、解析、复核、导出及配置操作保留创建者或操作者审计信息。
- 账号由管理员创建、启用、停用和重置初始密码；不提供自助注册、邮件找回或 SSO。
- SQLite 仍是单一权威数据库，位于主机本地持久目录，应用只运行一个实例。
- Docker Compose 或等价受控运行单元提供镜像、环境配置、健康检查、数据卷、日志与升级回滚流程。
- CI 在合并前执行现有质量命令；局域网部署不自动发布。

角色定义：

| 角色 | 允许的核心操作 |
| --- | --- |
| 管理员 | 账号、角色、系统配置、模型池、备份恢复、审计查询、全部业务操作 |
| 配置人员 | 板块、字段、知识库、模型配置与模型池；不管理账号或恢复备份 |
| 操作人员 | 导入、创建任务、发起/暂停/取消解析、查看共享数据、导出 |
| 审核人员 | 查看共享数据、处理复核、导出审核结果；不导入或发起解析 |
| 只读人员 | 查看被授权的共享任务、记录、结果和状态；不修改、不导出 |

## User Stories

1. As an administrator, I want to create an internal account and assign one role, so that colleagues can access the LAN system without public registration.
2. As an administrator, I want to disable an account immediately, so that departed or unauthorized staff lose access without changing shared data.
3. As an administrator, I want to reset an account's initial password, so that I can recover internal access without email delivery.
4. As any authorized user, I want to sign in and sign out through a secure session, so that my actions are attributable to me.
5. As any authorized user, I want to see shared organization tasks and records after sign-in, so that teams can collaborate on the same workload.
6. As an operator, I want to import a workbook and create an analysis task, so that the organization can process new customer data.
7. As an operator, I want to start, pause, cancel, retry, and export permitted tasks, so that I can run daily analysis without configuration privileges.
8. As a reviewer, I want to view records awaiting review and save review outcomes, so that parsing results are confirmed by a separate role.
9. As a reviewer, I want to export reviewed results, so that validated analysis can be delivered without granting model or configuration access.
10. As a configuration user, I want to manage sections, fields, knowledge bases, model settings, and pool members, so that analysis behavior is maintained without account administration access.
11. As a read-only user, I want to inspect task and record results without modification or export controls, so that I can monitor work safely.
12. As an administrator, I want to inspect who imported, started analysis, reviewed, exported, or changed a configuration, so that operational incidents are traceable.
13. As an administrator, I want to run the application from a versioned image with persistent data volumes and health checks, so that a fixed LAN host can restart safely.
14. As an administrator, I want scheduled, recoverable backups of the database, uploads, generated exports, knowledge configuration, and required key material, so that a host or upgrade failure does not lose business data.
15. As a maintainer, I want CI to reject changes that fail installation, tests, type checks, lint, build, migration integrity, or smoke checks, so that LAN releases are reproducible.
16. As a future maintainer, I want organization and actor information represented in data and service contracts, so that a later multi-organization or hosted version does not require a security rewrite.

## Implementation Decisions

### Access and session model

- Add user, organization, password credential, session, and audit-event concepts. Initialize exactly one active organization during migration/bootstrap.
- Use opaque, server-stored session identifiers in `HttpOnly`, `Secure`, `SameSite=Lax` cookies. Session storage must support explicit revocation on sign-out, account disable, password reset, and expiry.
- Store passwords only as a deliberately slow, salted password hash. The password hash, session secret and existing model encryption key never appear in client payloads, logs, image layers, or committed configuration.
- The first administrator is created through a one-time, host-local bootstrap command or an explicitly documented first-run environment variable. It must fail closed after an administrator exists; it must not leave a reusable public bootstrap endpoint.
- Do not implement self-registration, password recovery email, OAuth, SAML, LDAP, SSO, MFA, API tokens, public invitation links, or impersonation in this release.

### Authorization and shared-data model

- Establish one server-side authorization service with named capabilities rather than scattering role-name checks through route handlers.
- Every non-health HTTP endpoint passes through session authentication. `/api/health` remains unauthenticated for container health checks; `/api/ready` exposes only minimal operational status and is restricted to administrators or a separately protected infrastructure path.
- Read access for all authenticated roles is organization-wide for ordinary tasks, records and analysis results. File/image download endpoints require the same authenticated access as their parent task or record.
- Write permissions follow the role matrix in Solution. Administrators retain all permissions.
- Configuration changes, account administration, model pool validation/removal, imports, analysis lifecycle changes, review submissions, exports, backup/restore actions, authentication failures and session revocations create immutable audit events with actor, action, target type/ID, outcome, time, request correlation ID and safe metadata.
- Existing records have no historical author. Migration marks pre-upgrade items as system-created or unassigned; it must not invent a user. New actions record actual actors.
- Add `organization_id` to organization-owned root entities and propagate it through repository/service assertions. Child data remains reachable only through an organization-owned parent. In the single-organization release, every server-side lookup still checks the organization relationship.

### Frontend behavior and state

- Add an unauthenticated sign-in screen. Do not fetch ordinary application data before session establishment.
- Establish an authenticated application shell that loads current user and capabilities once, exposes account sign-out, and gates navigation/actions by capabilities.
- Preserve existing frontend layering: API clients perform transport, domain hooks own asynchronous state and invalidation, and components render or collect user input. Authentication state must not be mixed into record selection, polling, model-pool or section-configuration hooks.
- A denied response clears stale privileged UI state, reports an access error, and never leaves prior task data visible after sign-out or session expiry.
- The frontend may hide unavailable actions, but all server-side endpoints remain authoritative.

### Data migration and compatibility

- Add new migrations only; existing migrations through the current locked sequence remain immutable.
- Migrate existing rows transactionally, create the singleton organization, establish the first admin through controlled bootstrap, and preserve existing task, record, analysis, model, knowledge and backup data.
- Add audit indexes for organization, actor, target and time-range reads. Add authorization query indexes only where measured query plans require them.
- Keep SQLite for the LAN release: one application process, database file and data directory on a local disk, no network share, and no horizontal replicas. The launcher’s single-instance protection remains mandatory.
- Maintain repository/service interfaces so a future PostgreSQL migration changes persistence adapters and migrations rather than authorization semantics. This release does not migrate databases.

### LAN deployment and image

- Create a production container image using a pinned supported Node 22 base, reproducible dependency installation, built static assets and a non-root runtime user.
- Run one app container through Docker Compose or an equivalent declarative runtime. Persist `DATA_DIR`, SQLite database, generated secrets/key files, backups and logs outside the image on host-local volumes.
- Supply a versioned environment template without secrets. Deployment requires unique session and encryption secrets, a configured internal base URL, explicit data-volume paths, resource limits and a fixed application port.
- Place an internal reverse proxy or approved TLS terminator in front of the application. Restrict network access to approved LAN subnets and do not publish the application directly to the public Internet.
- Define health checks, startup ordering, log rotation, storage monitoring, graceful shutdown, upgrade backup, image version pinning and a documented rollback to the prior image plus restored data snapshot.
- Backups must cover the SQLite database, uploaded sources, extracted images, exports, knowledge snapshots, configuration and the separately secured encryption-key material. Restore is tested into a separate location before release acceptance.

### CI and operational quality

- Repair existing asynchronous test warnings and installation-lock consistency before making them merge gates.
- Add CI that runs in a clean checkout and executes `npm ci`, `npm run check:installation`, `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run db:check`, and `npm run smoke`.
- Build the production image in CI after quality gates. Publish or deploy only after a later explicit registry and deployment decision; this release produces a verified image artifact, not automatic LAN deployment.
- Add deployment documentation for first install, administrator bootstrap, secrets handling, LAN TLS, backup schedule, restore drill, upgrade, rollback and incident log collection.

## Testing Decisions

The highest useful automatic seam is the existing HTTP route integration boundary backed by an isolated SQLite database. Tests must create users and sessions, issue real route requests, and assert status, response body, database state and audit events.

- Authentication: sign-in success/failure, expired/revoked session, sign-out, disabled account, password reset, bootstrap closure, cookie security attributes and no credential leakage.
- Authorization matrix: test every role against representative account, configuration, model pool, import, analysis lifecycle, review, export, read, backup/restore and audit endpoints. Verify server rejection directly, not only hidden frontend controls.
- Shared data: every authenticated role can read valid organization data; unauthorized mutation and anonymous file/image access fail; stale user state is cleared after session loss.
- Audit: each sensitive success and denial has the correct actor, action, target, outcome and safe metadata. Passwords, session IDs and API keys are absent from events.
- Migration: existing pre-upgrade fixture data survives; only one organization is created; legacy rows have valid system/unassigned attribution; locked migration checks continue to pass.
- Frontend component tests: sign-in loading/error state, capability-gated controls, sign-out clearing state, and distinct operator/reviewer workflows. No new browser E2E framework is introduced in this phase.
- Deployment: validate image build, runtime health endpoint, read-only filesystem assumptions where possible, volume persistence across container recreation, restore to a separate directory, and one manual LAN acceptance using internal HTTPS from another workstation.
- Regression gates: `npm ci`, installation check, test suite, type check, lint, build, database check and smoke test pass in CI.

## Out of Scope

- Public Internet access, public DNS, public certificate automation, WAF and external identity-provider integration.
- Multiple organizations, customer tenancy, department-level record isolation, row-level personal data permissions, or cross-organization sharing.
- Self-service registration, email reset, invitations, MFA, SSO, LDAP, OAuth, SAML and API tokens.
- Multiple web instances, background worker fleet, queue infrastructure, high availability, zero-downtime deployment or Kubernetes.
- SQLite-to-PostgreSQL execution; only compatibility evaluation and migration boundaries are included.
- Replacing existing AI providers, changing analysis behavior, or automatic model/field configuration changes.

## Further Notes

- The resulting LAN release is a single-organization collaboration product, not a hosted SaaS release. `organization_id` is an intentional future boundary, not a claim of present multi-tenancy.
- Existing local backups exclude independently managed key files; the LAN deployment guide must make key backup and protected restore an explicit release requirement.
- Docker Desktop availability and the organization’s internal certificate issuance process must be confirmed before implementation starts. If Docker is unavailable on the host, provide a Windows service fallback with the same configuration, persistence, health and backup contracts.
- The current operation-efficiency plan for model validation, selected-record analysis and section metrics remains a separate functional workstream. Its sensitive endpoints must participate in the new authorization and audit model.

