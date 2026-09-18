# 客服解析中心 UI 设计文件包

**打包日期：** 2026-09-18

## 内容

- `src/client/`：全部前端页面、React 组件、Hooks、样式、登录与权限界面、管理界面和视觉资源。
- `src/shared/`：前端使用的共享类型与协议定义。
- `dist/`：当前版本的前端构建产物，可用于静态预览。
- `vite.config.ts`：前端开发与构建配置。
- `tsconfig.json`：TypeScript 配置。
- `package.json`、`package-lock.json`、`.npmrc`：前端安装与构建所需依赖信息。

## 不包含

- `node_modules/`
- 数据库、上传文件、知识库运行数据和备份
- `.env`、API Key、密码、会话 Cookie、加密密钥
- 后端运行代码和 Docker 数据卷

## 本地预览

在解压后的包根目录执行：

```powershell
npm ci
npm run build
```

前端开发服务器需要后端 API 配合；默认代理目标为 `http://127.0.0.1:8787`。
