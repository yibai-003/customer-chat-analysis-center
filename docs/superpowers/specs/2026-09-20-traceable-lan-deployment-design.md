# 可追溯局域网部署设计

**日期：** 2026-09-20

**关联工单：** `.scratch/lan-release-closure/issues/04-reproducible-lan-deployment-and-runtime-version.md`

## 目标

建立从 Git 提交、Docker 镜像、局域网容器到浏览器静态资源的单一版本链路。标准部署入口必须能够识别目标提交、验证运行版本、保留持久数据，并在新版本启动或核验失败时恢复上一个健康镜像。

真实固定主机发布、浏览器截图以及“发布 -> 回滚 -> 再发布”演练属于后续验收，不在本次自动实现的完成条件内。

## 现有基础

- `Dockerfile` 已使用固定 Node 22 基础镜像并提供 `/api/health` 容器健康检查。
- `deploy/docker-compose.yml` 已固定单实例容器、持久数据目录和知识库目录。
- `scripts/verify-lan-runtime.ps1` 已覆盖镜像构建、非 root、持久化和单实例保护。
- `/api/ready` 已覆盖磁盘空间和视觉/文本模型就绪状态，但需要管理员会话。

## 设计

### 1. 运行版本元数据

构建阶段通过 Docker build args 注入以下值：

- `APP_VERSION`
- `APP_COMMIT_SHA`
- `APP_BUILD_TIME`
- `APP_IMAGE`

运行时从同名环境变量读取。未注入时使用安全的开发默认值，不读取 Git 目录，也不暴露宿主机路径。

新增公开只读端点 `GET /api/version`，返回：

```json
{
  "success": true,
  "data": {
    "version": "0.1.0",
    "commitSha": "完整提交 SHA",
    "buildTime": "ISO-8601 时间",
    "image": "镜像标签",
    "assets": {
      "scripts": ["assets/index-....js"],
      "styles": ["assets/index-....css"]
    }
  },
  "error": null
}
```

端点只暴露发布追溯信息，不包含凭据、内部目录、数据库信息或模型配置。

### 2. 统一就绪状态

从现有 `/api/ready` 路由中抽出无 HTTP 依赖的就绪状态服务。该服务负责：

- 数据目录可访问；
- 数据库已初始化；
- 剩余磁盘满足 `MIN_FREE_DISK_MB`；
- 视觉和文本模型能力验证有效；
- 返回现有模型检查和可执行动作。

`/api/ready` 继续保持管理员权限和现有响应语义。新增容器内 CLI 使用同一服务并以退出码表达就绪结果，使部署脚本无需保存管理员密码或会话 Cookie。

### 3. 部署策略模块

新增纯 JavaScript 策略模块，负责可确定测试的逻辑：

- 根据包版本和提交 SHA 生成镜像标签；
- 校验提交 SHA、镜像标签和运行版本一致；
- 从入口 HTML 提取 JS/CSS 资产；
- 比较入口资产与 `/api/version` 报告；
- 根据新容器健康、就绪和版本核验结果决定保留新版本或回滚。

策略模块不执行 Docker、Git 或文件删除操作。Vitest 直接覆盖成功、版本不一致、旧资产、健康失败和回滚判定。

### 4. 标准部署脚本

新增 `scripts/lan-deploy.ps1`，支持正常发布和显式回滚：

1. 定位仓库根目录并检查 Git 工作区。
2. 正式发布拒绝未提交改动；预览模式必须显式启用。
3. 读取完整提交 SHA、短 SHA和 `package.json` 版本。
4. 运行安装检查、测试、类型检查、Lint 和生产构建。
5. 使用版本 build args 构建带提交 SHA 的镜像。
6. 读取当前容器、镜像标签、镜像 ID和版本信息作为回滚目标。
7. 使用现有 Compose 配置替换应用容器，不删除数据或知识库目录。
8. 等待 Docker healthcheck，通过容器内 CLI检查就绪状态。
9. 校验 `/api/version`、镜像标签、完整 SHA和入口 HTML静态资源。
10. 任一步失败时恢复旧镜像，再次检查健康与版本。
11. 成功时输出入口、提交、镜像标签、镜像 ID和回滚命令。

回滚模式只允许切换到显式提供的旧镜像标签，不执行镜像删除、数据目录清理或配置重置。

### 5. Compose 与镜像

- `Dockerfile` 声明并写入版本 build args。
- Compose 向容器传递运行版本变量。
- Compose 继续复用既有 `DEPLOY_DATA_DIR` 与 `DEPLOY_KNOWLEDGE_DIR`。
- 开发端口和局域网容器端口通过脚本参数与输出明确区分。
- 不新增长期保存的管理员凭据或部署令牌。

## 错误处理

- 工作区不干净、质量门禁失败或 Docker 不可用时，在替换容器前停止。
- 新容器未健康、未就绪、版本不一致或入口资源不一致时执行自动回滚。
- 回滚失败时保留诊断输出和当前容器状态，不删除数据或旧镜像。
- 所有失败使用非零退出码，成功输出不得在核验完成前出现。

## 测试

自动测试覆盖：

- 镜像标签生成与非法 SHA；
- 运行版本一致与不一致；
- HTML资产提取与旧资源检测；
- 健康、就绪、版本任一失败时要求回滚；
- `/api/version` 不泄露内部信息；
- `/api/ready` 与容器内 CLI复用同一就绪服务；
- Compose 环境变量和 Docker构建元数据存在。

完成后运行：

- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run db:check`
- `npm run smoke`

## 验收保留项

以下项目不因代码和自动测试通过而自动勾选：

- 在 `http://172.16.20.178:8788` 发布真实新镜像；
- 核验真实浏览器显示目标提交的 UI；
- 真实数据与模型凭据持久化检查；
- “新版本发布 -> 浏览器核验 -> 回滚 -> 再发布”现场演练；
- 截图、容器 ID、镜像 ID和前后版本证据归档。

