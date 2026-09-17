# 依赖漏洞定向修复

## 修复结果（2026-09-13）

本阶段把 npm 审计报告从 7 项（5 中危、1 高危、1 严重）降为 0 项；全部依赖与 `--omit=dev` 的运行依赖审计均返回退出码 0。该结论限于当次 npm 公告数据库，并不代表整个应用不存在漏洞。

| 依赖链 | 变更 | 原因 |
| --- | --- | --- |
| Vitest / mocker / 嵌套 Vite、esbuild、vite-node | Vitest 2.1.9 → 固定 4.1.11 | 使用修复版测试框架，移除旧 Vite 5 与 esbuild 0.21 依赖链，复用现有 Vite 8.2.2 |
| ExcelJS → uuid | ExcelJS 保持 4.4.0，通过仅针对 ExcelJS 的 override 将 uuid 8.3.2 → 11.1.1 | 修复 uuid 公告问题，保留 CommonJS v4 API，避免审计自动建议的 ExcelJS 降级 |

依据：[Vitest mocker 官方公告](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9)、[uuid 官方公告](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq)、[Vitest 迁移指南](https://vitest.dev/guide/migration/)。Vitest 公告列出 4.1.11 为修复版本，因此无需为此问题直接迁移到 5.x。

旧 Vitest 严重漏洞关联其 UI 服务暴露场景；当前项目使用 `vitest run`，没有配置测试 UI 服务。uuid 公告针对带缓冲区参数的 v3/v5/v6，本项目 ExcelJS 源码只调用 v4 生成扩展条件格式 ID。这些是实际调用范围核对，不用来忽略有修复版本的依赖。

## 实现与兼容性

- 运行依赖版本变化仅 uuid；SQLite、ExcelJS、React、Express 及生产 Vite 版本保持不变。Vitest 相关测试工具依赖同步更新，锁文件从 482 个节点降为 402 个节点（含根与跨平台可选节点）。
- 保留官方 registry、完整性校验、严格 TLS 及 SQLite `gypfile=false` 兼容元数据。锁文件生成工具仍可能丢弃该标记，`check:installation` 会发现问题。
- 测试范围明确为 `src/**/*.test.{ts,tsx}`，防止 `data` 中保留的隔离项目副本被递归当成测试；默认最大 4 个 worker，减少 Windows 资源争用。Vitest 4 不再使用旧 `--minWorkers` 参数，运行 `npm test` 即可。
- 新增 Excel 兼容性测试，真正写出含两个扩展条件格式和截图的工作簿，检查 UUID 为唯一有效 v4，重新加载后数据和图片字节保持一致。
- 保留全部既有测试，验证知识匹配/分类导出、复核结果、图片导出以及完整备份恢复。不通过减少断言或放宽业务逻辑适配框架。

## 验收与发布

隔离证据目录：`data/dependency-verification/20260913/`；包含安装日志与 `audit-all.json` / `audit-production.json`。仅用源码、仓库知识快照和独立测试数据，没有复制真实密钥或调用付费模型。

1. 新目录 `npm ci` 成功，安装 332 个本机适用包，SQLite/FTS5 检查通过。
2. 类型检查、构建通过；Vitest 4.1.11 下 54 个文件、341 项测试全部通过（原 340 项加 1 项 Excel 兼容测试）。
3. 全部依赖与运行依赖审计均为 0；原高危/严重旧测试依赖链不再存在。
4. 本机更新前确认无在途任务，创建已验证完整备份 `data/backups/full-2026-09-13T06-37-46-597Z-7204464a-7c0a-4663-a024-17e534355f45`。
5. 停止已确认的服务进程后执行主项目 `npm ci`、安装检查及构建，再通过日志入口重启。页面、健康和模型接口返回 200；4 组模型配置可读，新密钥可解密且无 pending；本机运行依赖审计也为 0。

当前边界：部分旧间接包仍有弃用提示，esbuild 有 npm 安装脚本许可元数据提示，Vite 有未来原生配置加载器扩展名警告；本次安装与构建均成功。持续关注新公告，后续依赖升级继续进行定向评估与回归，不使用 `npm audit fix --force` 无差别变更依赖。

回退：停止服务，恢复上一个代码及锁文件版本，使用 `npm ci` 重新安装、构建、启动。此阶段没有数据库结构变更，通常无需恢复数据库；旧密钥迁移阶段的回退要求仍适用。
