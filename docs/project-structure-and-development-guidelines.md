# 项目目录结构与后续开发规范

**日期：** 2026-09-18  
**适用范围：** 客服解析中心当前局域网版本及后续功能开发  
**文档性质：** 长期维护规范

## 1. 总体评价

当前项目的目录组织整体规范度为**中上水平**，已经具备持续开发所需要的基本分层：

- 前端、服务端、共享契约和测试边界明确。
- 路由、业务服务、数据库、安全、认证和 AI 调用已有独立目录。
- 数据库迁移采用顺序编号，并有不可变校验。
- 部署配置、运维脚本、长期指南、架构决策和历史记录已分开管理。
- 测试文件大多与实现文件放在同一模块附近，便于定位行为和回归风险。
- 本地数据、密钥、依赖、构建产物和工作树已通过 `.gitignore` 隔离。

项目目前不是目录混乱型仓库，后续不需要进行大规模重排。更重要的是保持现有边界，避免新功能重新堆回 `App.tsx`、`app.ts`、大型组件或单一 service。

当前仍有四类结构性问题需要持续控制：

1. `.scratch/` 中的局域网工单已经成为正式交付依据，但目录名称仍带有临时文件语义。
2. `PoolView.tsx`、`model-pool-service.ts`、`shared/types.ts` 等文件职责开始变宽。
3. 活跃计划、进度账本、验收文档和工单状态可能出现不同步。
4. `.env`、`data/`、`dist/`、Excel 样例等本地文件虽然没有提交，但会增加根目录噪音。

## 2. 当前目录结构

```text
客服解析中心/
├── .github/
│   └── workflows/                 # GitHub Actions 质量闸门和发布工件
├── .scratch/
│   └── lan-single-organization-upgrade/
│       ├── spec.md                # 当前局域网升级总规格
│       └── issues/                # 当前局域网升级工单 01-12
├── config/                        # 可提交的配置模板
├── data/                          # 本机数据库、上传、图片、导出、日志和备份
├── deploy/                        # Compose、部署环境模板和反向代理示例
├── dist/                          # Vite 构建产物
├── docs/
│   ├── adr/                       # 长期架构决策
│   ├── archive/                   # 已完成或一次性的实施、验收记录
│   ├── guides/                    # 长期有效的操作和技术指南
│   ├── superpowers/               # 历史规格和实施计划
│   ├── README.md                  # 文档总索引
│   └── *.md                       # 当前活跃计划、进度和开发流程
├── knowledge/                     # 可版本化的知识配置快照
├── scripts/                       # 启动、检查、冒烟和验收脚本
├── src/
│   ├── client/                    # React 前端
│   ├── server/                    # Express 服务端
│   ├── shared/                    # 前后端共享类型和契约
│   └── test/                      # 全局测试初始化
├── .env.example                   # 环境变量模板，不包含真实秘密
├── Dockerfile                     # 生产镜像定义
├── package.json                   # 脚本、依赖、Node 版本和项目版本
└── README.md                      # 项目入口、启动和主要业务说明
```

以下目录属于本地生成物或工具状态，不应作为业务代码和长期文档入口：

```text
.git/
.superpowers/
.worktrees/
node_modules/
dist/
data/
release/
```

## 3. 各目录职责

### 3.1 `src/client`

前端代码按职责继续保持以下方向：

```text
src/client/
├── api/             # HTTP 传输封装
├── auth/            # 登录、会话和前端能力状态
├── components/      # 页面和可复用组件
│   ├── admin/       # 管理员功能
│   ├── knowledge/   # 知识库工作区
│   └── model-config/# 模型配置和模型池
├── hooks/           # 异步流程、选择、轮询和领域状态
├── assets/          # 静态视觉资源
├── App.tsx          # 应用组合层
└── styles.css       # 当前全局样式入口
```

约束：

- 组件负责展示和采集输入，不直接实现复杂请求流程。
- HTTP 请求集中在 API 层，异步状态和刷新策略放在 hooks。
- `App.tsx` 只负责组合工作区、对话框和顶层状态，不继续吸收业务细节。
- 权限隐藏只改善用户体验，真正授权必须由服务端完成。
- 新增大型功能时优先建立独立组件目录，不在 `components/` 根目录持续堆文件。

### 3.2 `src/server`

服务端当前主要结构：

```text
src/server/
├── ai/              # 模型传输、响应处理和模型调用能力
├── auth/            # 身份、会话、密码、能力和审计
├── db/
│   └── migrations/  # 顺序迁移、锁文件和迁移测试
├── routes/          # HTTP 路由适配
├── security/        # 输入、上传、磁盘和访问边界
├── services/
│   ├── execution/   # 字段执行类型注册和处理器
│   └── knowledge/   # 知识导入、检索、同步和热点服务
├── utils/           # 无领域归属的轻量工具
├── app.ts           # Express 应用装配
└── startup.ts       # 启动过程
```

推荐依赖方向：

```text
route -> service -> repository / AI / security
                  -> shared contract
```

约束：

- 路由只处理 HTTP 输入、能力检查、状态码和响应格式。
- 业务规则放入 service，不在路由中复制。
- 数据查询和写入通过数据库或 repository 边界完成。
- service 不应依赖 Express 的 `Request`、`Response`。
- `app.ts` 只负责中间件和路由装配，不继续加入大段业务实现。
- 通用安全校验必须集中实现，不能由每个路由自行拼接。

### 3.3 `src/shared`

`src/shared` 只保存前后端都需要的稳定契约，例如：

- API 数据类型。
- 枚举、状态和能力名称。
- 共享 schema 或不依赖运行环境的纯函数。

禁止放入：

- React 组件或浏览器 API。
- 数据库连接、文件系统和服务端秘密。
- 仅服务端使用的内部模型。
- 仅为减少 import 路径而创建的无边界“大杂烩”。

当前 `types.ts` 已经较大。后续新增完整领域时，应按领域拆分为 `auth.ts`、`jobs.ts`、`models.ts` 等，并由 `index.ts` 统一导出，避免继续扩大单文件。

### 3.4 数据库迁移

迁移文件使用：

```text
NNN-short-description.ts
```

规则：

1. 已发布迁移只增不改。
2. 新结构变化必须新增下一编号迁移。
3. 同步更新 `migrations.lock.json`。
4. 迁移必须处理旧数据兼容和失败回滚。
5. 必须运行迁移测试和 `npm run db:check`。
6. SQLite 局域网版本保持单实例、本机磁盘，不放在网络共享目录。

### 3.5 `scripts` 与 `deploy`

`scripts/` 保存开发和运维命令实现，`deploy/` 保存部署声明和模板，两者不要混用。

- 启动、冒烟、验收、备份恢复验证放在 `scripts/`。
- Compose、反向代理和部署环境模板放在 `deploy/`。
- 脚本必须支持失败退出码，不能只输出失败文字后仍返回 0。
- 示例配置不得包含真实域名、密码、API Key 或加密密钥。
- 新增脚本后应在 `package.json`、相关指南或运维手册中提供稳定入口。

### 3.6 `docs`

文档按生命周期分类：

| 类型 | 位置 | 示例 |
| --- | --- | --- |
| 文档索引 | `docs/README.md` | 所有长期文档入口 |
| 长期操作指南 | `docs/guides/` | 部署、备份、迁移、安全 |
| 架构决策 | `docs/adr/` | 数据隔离、数据库、部署模型 |
| 活跃实施计划 | `docs/` 根目录 | 当前仍在执行的计划 |
| 历史规格和计划 | `docs/superpowers/` | 已实施设计和计划 |
| 一次性验收记录 | `docs/archive/` | 演练、修复和发布记录 |

不要为每次小修复创建一篇新报告。优先更新已有指南、进度账本、验收记录或工单。

## 4. 工单的固定位置

当前局域网版本的工单唯一入口是：

```text
.scratch/lan-single-organization-upgrade/issues/
```

当前发布线执行期间不要移动这些工单，也不要在其他目录复制同名工单。每张工单至少包含：

```markdown
# 编号和标题

**What to build:** 要交付的结果
**Blocked by:** 前置工单
**Status:** ready-for-agent / in-progress / in-review / done

- [ ] 可验证的验收条件
```

工单状态定义：

| 状态 | 含义 |
| --- | --- |
| `ready-for-agent` | 已明确，可开始实施 |
| `in-progress` | 正在修改代码或环境 |
| `in-review` | 代码完成，但仍有验证或人工验收 |
| `done` | 所有验收条件均有证据 |

需要注意：`.scratch` 通常表示临时工作区，不适合作为所有未来项目的永久工单中心。当前局域网发布完成后，应将最终规格和验收记录归档到 `docs/archive/`。下一个大型项目建议使用：

```text
docs/work-items/<initiative-name>/
├── spec.md
└── issues/
```

这样工单既有固定位置，也不会和本地临时文件混淆。

## 5. 文件命名与排版

### 5.1 代码文件

- React 组件：`PascalCase.tsx`
- React hooks：`useSomething.ts`
- 普通 TypeScript 模块：`kebab-case.ts`
- 测试：与实现同目录，使用 `*.test.ts` 或 `*.test.tsx`
- 迁移：`NNN-kebab-case.ts`
- PowerShell：`kebab-case.ps1`
- Node 脚本：`kebab-case.mjs`

同一目录内不要混合多种命名方式表达同一种文件。

### 5.2 Markdown

每篇文档只使用一个一级标题。长期文档建议在标题后提供日期、范围或状态：

```markdown
# 文档标题

**日期：** 2026-09-18
**状态：** 实施中
**关联工单：** 10
```

排版要求：

- 标题按 `#`、`##`、`###` 顺序递进，不跳级。
- 路径、命令、环境变量和代码名称使用反引号。
- 多行命令使用带语言标识的代码块。
- 比较多个固定项目时使用表格，执行步骤使用编号列表。
- 不使用“基本完成”“大概没问题”等无法验收的状态描述。
- 文档引用仓库内其他文件时使用相对链接。
- 新增长期文档后必须更新 `docs/README.md`。

## 6. 新功能应该放在哪里

| 新内容 | 推荐位置 |
| --- | --- |
| 新页面或完整功能区 | `src/client/components/<feature>/` |
| 页面异步状态和操作 | `src/client/hooks/` 或功能目录内 hook |
| API 请求函数 | `src/client/api/` |
| 新 HTTP 接口 | `src/server/routes/` |
| 新业务规则 | `src/server/services/` |
| 新字段执行类型 | `src/server/services/execution/` |
| 新知识库行为 | `src/server/services/knowledge/` |
| 新认证或权限行为 | `src/server/auth/` |
| 新输入和资源限制 | `src/server/security/` |
| 新持久化结构 | `src/server/db/migrations/` |
| 前后端共享契约 | `src/shared/` |
| 运维命令 | `scripts/` |
| 部署模板 | `deploy/` |
| 长期技术说明 | `docs/guides/` |
| 重要架构选择 | `docs/adr/` |
| 发布或演练证据 | `docs/archive/` |

## 7. 文件规模和模块边界

文件行数不是唯一质量标准，但可以作为拆分信号：

- 组件超过约 400-500 行时，检查是否混合请求、状态、表格、表单和对话框。
- service 超过约 500-600 行时，检查是否包含多个独立业务能力。
- 共享类型文件持续增长时，按领域拆分，不按“请求/响应/枚举”机械拆分。
- 测试文件可以比实现更长，但超过约 800-1000 行时，应按行为场景拆分以减少定位成本。

当前优先观察对象：

- `src/client/components/model-config/PoolView.tsx`
- `src/server/services/model-pool-service.ts`
- `src/shared/types.ts`
- `src/server/app.ts`

拆分必须以职责边界为依据，不能只为了降低行数制造大量薄文件。

## 8. 后续开发流程

### 8.1 开发前

1. 确认需求属于现有工单，还是需要新规格和工单。
2. 写清用户行为、服务端约束、失败情况和验收标准。
3. 判断是否涉及权限、审计、迁移、备份和部署。
4. 查找已有 service、hook 和共享类型，避免建立重复抽象。

### 8.2 实施中

1. 优先编写或更新自动化测试。
2. 保持既有依赖方向，不从底层模块反向依赖页面或路由。
3. 所有敏感操作同时考虑能力检查和审计事件。
4. 异步任务必须处理超时、取消、重试、重复点击和进程重启。
5. 模型调用必须服从请求预算、取消信号和模型池状态。
6. 不修改已冻结迁移，不在日志和响应中输出凭据。
7. 不顺手重构与当前工单无关的模块。

### 8.3 提交前

至少运行：

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npm run db:check
npm run smoke
npm run check:installation
```

涉及容器、部署、备份或局域网运行时，还应执行对应验证脚本：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-lan-runtime.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-backup-restore.ps1
```

本地通过不能替代 GitHub Actions 通过。发布工单必须记录远端运行、提交 SHA、工件和清单证据。

### 8.4 完成后

1. 更新工单状态和每项验收勾选。
2. 更新活跃进度账本，移除已失效的“待提交”或“待验收”描述。
3. 将长期有效信息写入指南，将一次性证据写入归档。
4. 检查 `docs/README.md` 链接。
5. 确认 `git status` 中没有 `.env`、数据、密钥、备份和临时输出。

## 9. 安全与数据注意事项

- `.env`、`deploy/.env`、数据库、备份、日志、Excel 和密钥不得提交。
- `.env.example` 只提供变量名和无敏感示例。
- API Key 只以加密形式持久化，不进入审计、响应或测试附件。
- 新路由默认需要身份认证；只有明确的健康检查可以匿名访问。
- 前端隐藏按钮不是授权措施，服务端必须独立返回 `401` 或 `403`。
- 组织归属、任务归属和记录归属必须由服务端查询验证。
- 上传和解压继续执行大小、格式、磁盘余量和路径穿越检查。
- 备份必须包含数据库及引用文件，并单独保护匹配的加密密钥。

## 10. 当前建议

### 必须保持

- `client / server / shared` 三层边界。
- route、service、repository/AI 的依赖方向。
- 测试与实现共置。
- 迁移只增不改和迁移锁校验。
- `guides / adr / archive` 文档生命周期分类。
- 局域网版单实例 SQLite 和主机本地持久目录。

### 应逐步改进

- 局域网发布结束后，不再把长期新项目工单放入 `.scratch`。
- 拆分继续增长的模型池组件、服务和共享类型。
- 为活跃项目只保留一个权威状态入口，其他文档引用该入口。
- 逐步清理 lint warning，并把高风险规则提升为 error。
- 将本地 Excel 样例和人工验证输出集中到被忽略的专用目录，减少根目录噪音。
- README 保持为入口说明，详细运维内容继续下沉到 `docs/guides/`。

## 11. 最终判断

当前目录结构可以支撑继续开发，不需要推倒重建。它的主要风险不是“目录不规范”，而是随着功能增加出现以下退化：

- 顶层组件重新变成全局状态容器。
- 路由重新承载业务规则。
- service 和共享类型继续无边界膨胀。
- 工单、进度和验收文档各自维护不同状态。
- 本地通过被误认为已经完成发布验收。

后续开发只要坚持模块职责、单一工单入口、可验证验收和远端质量闸门，这个仓库可以继续平稳演进到正式局域网版本，并为未来服务型数据库和线上部署保留清晰的改造边界。
