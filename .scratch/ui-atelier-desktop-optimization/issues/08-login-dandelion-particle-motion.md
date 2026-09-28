# 08: 登录页蒲公英粒子动效替换

**Status:** implemented, pending real LAN acceptance
**Created:** 2026-09-28
**Priority:** medium
**Owner:** frontend / sign-in
**Scope:** 登录页左侧装饰画布、Canvas 运行时、响应式与低动态偏好

## 背景

登录页原有大型浮动蕨叶插画占据视觉中心，但动态表达与用户提供的蒲公英参考不一致。需要保留现有登录业务和淡蓝灰工作台入口风格，仅替换装饰区域的视觉与运动方式。

## 目标

1. 删除登录页大型浮动蕨叶插画。
2. 使用轻量 Canvas 绘制蒲公英主体、白色种子和较长尾迹。
3. 粒子扩散距离、范围、亮度和宽度接近确认稿，不把视频作为背景。
4. 动效不覆盖表单，不影响登录交互，并支持窄屏和低动态偏好。

## 实施约束

- 不修改认证 API、Session、权限、账号密码流程或管理员初始化逻辑。
- 不引入外部动画库、远程图片或视频运行时依赖。
- Canvas 必须 `aria-hidden="true"` 且不可聚焦。
- 复用统一的 Canvas 生命周期、设备像素比、可见性和低动态处理。
- 工作台主题文件不得新增登录页选择器；登录样式继续由 Atelier 登录主题负责。

## 验收标准

- [x] 登录页不再显示大型浮动蕨叶插画。
- [x] 蒲公英主体和白色粒子在桌面端实际绘制，画布不是空白。
- [x] 白色粒子尾迹、亮度、宽度和收紧后的扩散范围符合确认效果。
- [x] `390x844` 下无横向滚动、文字裁切或表单遮挡。
- [x] `1440x900` 下登录表单、流程区和蒲公英画布无重叠。
- [x] `prefers-reduced-motion` 与页面不可见时不会持续运行高频动画。
- [x] 组件、Canvas 运行时、登录结构和样式契约测试通过。
- [ ] 在真实局域网入口完成一次登录、退出和重新登录验收。

## 相关文件

- `src/client/components/DandelionCanvas.tsx`
- `src/client/components/DandelionCanvas.test.tsx`
- `src/client/components/canvas-runtime.ts`
- `src/client/components/canvas-runtime.test.ts`
- `src/client/components/LoginAnalysisCanvas.tsx`
- `src/client/atelier-theme.css`
- `src/client/auth/auth-gate.test.tsx`
- `src/client/workspace-style-contracts.test.ts`

## 验证

```powershell
npx vitest run src/client/components/DandelionCanvas.test.tsx src/client/components/canvas-runtime.test.ts src/client/auth/auth-gate.test.tsx src/client/workspace-style-contracts.test.ts
npm run typecheck
npm run lint
npm run build
```

真实浏览器检查目标视口：`390x844`、`1024x768`、`1366x768`、`1440x900`。
