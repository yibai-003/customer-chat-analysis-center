# 本地访问防护与启动配置

## 访问范围

服务继续监听 `127.0.0.1`。在 JSON 解析、文件上传和业务路由之前检查 Host 与浏览器 Origin：允许 localhost、127.0.0.1、IPv6 回环名称；只允许当前后端端口或指定的 Vite 5173 页面来源。拒绝第三方网站来源、opaque/null 来源、非本机 Host 和无 Origin 的 cross-site 浏览器请求。

本机终端不带 Origin 时仍可使用接口；这不是身份认证，也不能阻止本机其他程序访问数据。不要为了局域网上线添加宽泛 CORS 或移除防护；团队访问需另加认证、HTTPS 和来源白名单。

## 环境变量

`src/server/environment.ts` 读取项目根目录 `.env`，只加载项目支持的配置键。操作系统/命令行显式环境变量优先，不会被文件覆盖。测试不自动读取真实 `.env`。

支持 PORT、DATA_DIR、DATABASE_PATH、ENCRYPTION_KEY、MAX_UPLOAD_MB、ANALYSIS_CONCURRENCY、ANALYSIS_BATCH_SIZE、MIN_FREE_DISK_MB、BACKUP_INTERVAL_HOURS、BACKUP_RETENTION、CLEANUP_RETENTION_DAYS。不从文件加载 NODE_OPTIONS、PATH 等进程选项。

相对 DATA_DIR / DATABASE_PATH 从项目根目录解析；官方启动入口会固定工作目录，静态页面也从项目根目录的 dist 加载。模型地址与 API Key 仍在页面配置，删除了不会生效的 AI_* 示例配置。

后续密钥管理单元已完成：新环境生成独立随机文件密钥，旧默认密钥数据需离线迁移，不再为实际运行环境隐式使用固定密钥。已有独立 ENCRYPTION_KEY 保持优先，启动前验证能否解密全部模型凭据。新机器恢复必须保留与数据库匹配的密钥文件或独立环境密钥，见 [密钥管理与迁移](encryption-key-management.md)。

## 启动

使用 Node.js 22.12 或更新版本，确保 node.exe 与 npm.cmd 在 PATH 中。

```powershell
cd "E:\客服解析中心\customer-chat-analysis-center"
.\scripts\start-local.ps1
```

脚本依据自身位置进入项目，检查 Node 版本，缺依赖时执行 npm ci，通过安装检查后构建并启动；任一步失败立即停止。系统脚本策略不允许时，可运行等效的 `scripts/start-local.cmd`，无需修改全局执行策略。

`startup-launcher.vbs` 使用相对自身路径启动守护脚本。守护脚本通过 PATH 定位 Node，正常退出不重启，连续 5 次快速失败停止重试，避免配置错误或已有实例时无限循环。不会自动安装开机启动项，也未启用守护实例。后续安全维护单元已把 npm 与守护脚本统一接入日志启动器，支持 `LOG_MAX_MB` / `LOG_RETENTION`，见 [安全清理与日志指南](safe-maintenance-and-logs.md)。

## 开发代理

Vite 只监听 127.0.0.1:5173，启用 strictPort 避免自动换端口。代理根据同一 PORT 配置访问后端，重写 Host，保留浏览器 Origin 供来源校验。

后续依赖安装单元已将锁文件下载地址统一到官方 npm 源，项目和本机用户配置恢复严格证书校验，并声明 Node 版本要求。安装失败会明确停止，排查见 [可复现安装指南](reproducible-installation.md)。

## 本阶段验收（2026-09-13）

- `npm.cmd test -- --maxWorkers=4 --minWorkers=1`：50 个测试文件、308 项测试通过。备份恢复集成测试对子进程设置 10 秒超时，整体设置 20 秒预算，避免原 5 秒测试超时早于子进程结束导致清理冲突。
- `npm.cmd run typecheck`、`npm.cmd run build` 通过。构建仍提示 Vite 未来原生配置加载器需要显式导入扩展名；当前版本构建及开发代理已验证，升级 Vite 时需处理。
- 两个 PowerShell 脚本语法解析、Node 版本解析通过；隔离子进程从临时目录读取配置，相对数据路径仍指向项目目录。
- 确认无在途分析/导入后重启；页面、健康接口返回 200，外部 Origin 的读写请求及原始 HTTP 伪造 Host 返回 403。
- 临时启动 5173 开发服务，携带页面 Origin 通过代理访问健康接口返回 200，验证后关闭该临时服务。
- 本次没有调用付费模型；没有进行全新机器依赖安装、开机启动或浏览器视觉验收。
