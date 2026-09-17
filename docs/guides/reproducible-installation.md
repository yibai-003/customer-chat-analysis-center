# 官方依赖源与可复现安装

## 本次修复

旧锁文件的 481 个依赖下载地址指向固定 IP 源，用户级 npm 配置为 `strict-ssl=false`。仅修改 npm registry 不能改变这些已经写进锁文件的地址。

本次将锁文件全部下载地址改为 `https://registry.npmjs.org/`，保留每个依赖的版本、完整性校验值和依赖关系。新增项目 `.npmrc`，设置官方 registry、`strict-ssl=true`、`engine-strict=true`；`package.json` 和锁文件根节点声明 Node.js >=22.12.0。开发机用户级 `strict-ssl` 也已恢复为 true，其余用户配置保留。

这次只整理安装来源与校验策略，不自动升级依赖版本，也不通过关闭 TLS 检查解决下载问题。

隔离安装还发现 `better-sqlite3@13.0.3` 的 `gypfile=false` 元数据在锁文件中缺失，导致 npm 11.17.0 根据 `binding.gyp` 错误触发源码编译。官方包实际已包含 Windows x64 等平台预编译文件。本次仅补回该元数据，原 tarball 和校验值不变。[官方包定义](https://raw.githubusercontent.com/WiseLibs/better-sqlite3/v13.0.3/package.json)、[npm 安装生命周期规则](https://docs.npmjs.com/cli/v11/using-npm/scripts/)。

不要通过忽略全部安装脚本绕过此问题。更新锁文件后执行 `npm run check:installation` 检查此标记、官方 URL 和实际 SQLite/FTS5 功能；统一启动脚本已接入此检查。以后升级 better-sqlite3/npm 时需重新验证锁文件生成行为。

## 新机器安装

安装 Node.js 22.12 或更新版本，并确保 node、npm、Git 在 PATH 中。在项目根目录执行命令；`E:\客服解析中心` 是上层目录，不是包含 `package.json` 的项目目录。

```powershell
git clone https://github.com/yibai-003/customer-chat-analysis-center.git
cd customer-chat-analysis-center
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，停止启动' }
npm.cmd run check:installation
if ($LASTEXITCODE -ne 0) { throw 'SQLite 安装检查失败，停止启动' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw '构建失败，停止启动' }
npm.cmd run start
```

也可以在克隆完成后运行 `scripts/start-local.ps1`，缺依赖时执行 `npm ci`，构建成功才启动。`npm ci` 使用锁定版本且检查包完整性；不要删除锁文件或用 `npm audit fix --force` 代替兼容性验证。

若 PowerShell 策略禁止执行 `.ps1`，运行 `scripts/start-local.cmd`：同样检查 Node、依赖、SQLite 和构建，各步失败立即停止，无需改变系统策略。本机验收确实遇到该限制，最终使用 `.cmd` 入口验证。

默认打开 `http://localhost:8787`。仓库知识快照会在新数据库初始化时恢复；真实聊天数据和模型 API Key 不随代码分发。恢复已有模型凭据须按 `encryption-key-management.md` 单独准备匹配的密钥。

## 下载失败排查

在项目目录检查有效配置：

```powershell
node --version
npm.cmd config get registry
npm.cmd config get strict-ssl
npm.cmd config get engine-strict
npm.cmd ping
```

期望官方 registry、证书校验 true、版本约束 true。命令行和环境变量可能覆盖项目 `.npmrc`；不要配置 `NODE_TLS_REJECT_UNAUTHORIZED=0` 或 `NPM_CONFIG_STRICT_SSL=false`。

超时先检查网络与代理；证书错误检查系统时间和公司代理所需的可信 CA。只有确认来源可信后才配置 CA 文件（如 `NODE_EXTRA_CA_CERTS`），不要通过禁用证书验证绕过错误。不要公开粘贴含令牌的完整 `.npmrc`。

当前锁定的 `better-sqlite3@13.0.3` 已在包内包含预编译文件；其他原生依赖通过平台对应包提供二进制。升级版本后发布方式可能变化，缺少目标系统/架构预编译时可能需要编译工具；不能用复制其他机器的 `node_modules` 代替正确安装。本次验证环境是 Windows x64、Node 24.19.0、npm 11.17.0，不代表已验证所有支持的系统/Node 组合。

## 验证证据

隔离目录：`data/install-verification/20260913-official-registry/`。使用项目代码副本、仓库已提交知识快照、新建 npm 缓存；不复制真实数据、密钥或原 `node_modules`。该目录位于 Git 忽略的 `data` 内，安装日志和验证产物保留在本机。

2026-09-13 验收结果：

- 最终空缓存 `npm ci` 成功，安装 344 个适用于本机平台的包，未关闭脚本执行或 TLS 校验。前次失败日志保留为 `install.log`；补回 gypfile 元数据后的成功日志为 `install-final.log`。
- 锁文件共 482 个节点（含根），481 个下载地址；除下载源、根 Node 约束及 SQLite gypfile 修复外，版本、依赖关系、校验值保持不变。
- 新安装环境 `check:installation` 验证 SQLite 3.53.4、FTS5 正常；类型检查、构建、53 个测试文件/340 项测试全部通过。
- 使用 `.env` 指定隔离端口 8788，从上层工作目录启动 `.cmd` 成功，证明入口按自身路径定位项目。页面、健康、模型列表和板块接口返回 200。
- 新建独立数据库、密钥和日志；仓库知识快照恢复出 6 个板块、15 个字段、2 个知识库、388 个知识条目；模型配置 0，数据库完整性正常、外键错误 0。
- 临时服务已停止，原 8787 服务健康正常；未迁移真实数据或调用付费模型。实际主服务未重启，本次修改在下一次安装/使用启动脚本时生效。
- PowerShell 启动脚本语法检查通过，但本机策略禁止直接执行；已实测等效 `.cmd` 入口。Vite 未来原生配置加载器警告仍存在，当前构建成功。

## 依赖审计待办

后续更新：下述初次审计的 7 项已在依赖安全单元中定向修复，当前 Vitest 4.1.11 / uuid 11.1.1 的全部与运行依赖审计均为 0；54 个文件、341 项测试通过。原始发现保留作为记录，详见 [依赖漏洞修复与验收](../archive/dependency-security-remediation.md)。当前 `npm ci` 安装 332 个本机适用包，运行测试使用 `npm test`，无需旧 `--minWorkers` 参数。

本次 `npm audit` 返回 7 项：5 moderate、1 high、1 critical。其中 `--omit=dev` 的运行依赖为 ExcelJS/uuid 链路 2 项 moderate；其余属于 Vitest 及其嵌套 Vite/esbuild/mocker/vite-node 工具链。原始报告保留在隔离目录 `audit-all.json`、`audit-production.json`。级别是 npm 审计结果，是否可利用仍需结合调用路径评估。

审计建议涉及 Vitest 大版本升级及 ExcelJS 降级，不能直接执行强制修复。下一交付单元应审查公告与实际暴露面，选择兼容升级/定向替换方案，并回归 Excel 图片导入导出和整套测试。安装成功不代表依赖漏洞已修复。npm 还提示 esbuild 安装脚本许可元数据和若干旧间接包弃用，本次脚本实际已运行成功，未增加泛化的脚本许可。
