# 07: 登录页透明水波交互层

**What to build:** 在登录页左侧分析流程画布增加低负荷、可交互的透明水波层。水波由鼠标移动、点击和低频环境脉冲触发，只作为背景反馈，不改变登录业务、不遮挡流程节点和植物标本。

**Blocked by:** 06: 登录工作台分屏与动态分析画布优化

**Status:** done (2026-09-20)

## Problem

1. 现有植物和纸片已有低幅度漂移动画，但用户对画布的直接操作缺少可感知反馈。
2. 参考界面的流体渐变效果依赖更重的图形实现，直接复制会增加局域网主机的持续渲染负担。
3. 水波必须保持透明、克制和工作台化，不能降低流程节点、状态文字和植物标本的可读性。

## Technical Decision

- 使用原生 Canvas 2D，不引入 WebGL、流体模拟库、动画库或外部资源。
- 水波层仅挂载到登录页左侧分析画布，位于流程节点、页头、页脚和植物内容之后。
- 鼠标移动按时间和距离双重节流；点击产生较强波纹。
- 同时最多保留 3 个波纹，目标刷新上限为 40 FPS。
- 设备像素比最高按 `1.5` 渲染，避免高分屏产生不必要的像素开销。
- 页面隐藏时清空并停止帧循环；页面恢复后再产生一次低强度波纹。
- `prefers-reduced-motion: reduce` 下不创建帧循环，并隐藏 Canvas 水波层。
- 无活动波纹时不持续请求动画帧；环境波纹每 3.6 秒低频触发一次。

## Scope

- 新增独立 `WaterRippleCanvas` 组件。
- 将组件挂载到 `LoginAnalysisCanvas` 背景层。
- 增加画布定位、透明度、混合模式和减少动态效果样式。
- 增加像素比、波纹数量、指针触发和减少动态效果测试。

## Out Of Scope

- 不改变账号密码登录、管理员初始化、Session 或权限逻辑。
- 不在登录表单区域增加水波。
- 不实现真实液体折射、图片像素扭曲、WebGL Shader 或全屏流体模拟。
- 不增加音效、触觉反馈、颜色主题切换或移动端水波交互。

## Acceptance Criteria

- [x] 水波 Canvas 只存在于左侧分析画布，且为透明背景。
- [x] 鼠标移动和点击能够触发水波。
- [x] 水波位于流程节点、植物和关键文字之后，不影响登录表单操作。
- [x] 不引入外部依赖、远程图片或公网资源。
- [x] 使用 Canvas 2D，不使用 WebGL 流体模拟。
- [x] 同时最多 3 个波纹，刷新上限约 40 FPS，设备像素比最高 1.5。
- [x] 页面隐藏时停止并清空动画，恢复后按需重启。
- [x] `prefers-reduced-motion: reduce` 下不启动水波动画。
- [x] 在 `1024x768`、`1366x768`、`1440x900`、`1920x1080` 下完成真实页面检查。
- [x] 登录专项测试、全量测试、类型检查、Lint 和生产构建通过。

## Test Plan

- [x] `WaterRippleCanvas` 组件存在且不进入辅助技术阅读顺序。
- [x] 设备像素比封顶为 1.5。
- [x] 波纹队列只保留最新 3 个。
- [x] 指针移动后执行实际 Canvas 绘制。
- [x] 减少动态效果时不请求动画帧。
- [x] 登录页原有结构与认证行为测试不回归。
- [x] 执行全量 `npm test`，90 个测试文件、691 个测试通过。
- [x] 执行 `npm run typecheck`。
- [x] 执行 `npm run lint`，无错误；保留项目既有警告，新文件无新增警告。
- [x] 执行 `npm run build`。
- [x] 真实浏览器验证指针移动、点击、环境波纹和层级关系；页面隐藏恢复由组件生命周期测试和实现检查覆盖。

## Expected Files

- `src/client/components/WaterRippleCanvas.tsx`
- `src/client/components/WaterRippleCanvas.test.tsx`
- `src/client/components/LoginAnalysisCanvas.tsx`
- `src/client/atelier-theme.css`
- `src/test/setup.ts`

## Completion Gate

只有自动化检查、四个目标视口和真实交互验证全部完成后，才能将状态改为 `done`。

## Implementation Result

- 新增透明 Canvas 2D 水波组件，登录页加载后先显示一次低强度环境波纹。
- 鼠标移动按 `110ms` 和 `22px` 双重阈值采样，点击产生更强波纹。
- 波纹寿命为 `1450ms`，最多同时保留 3 个，刷新上限约 40 FPS。
- 实际浏览器中 CSS 尺寸约 `720x683` 时，位图尺寸为 `1080x1024`，验证设备像素比封顶为 1.5。
- 前景页头、流程节点、植物和页脚设置指针穿透，拖动不会选中文字，事件稳定落到 Canvas。
- 浏览器控制台无错误或警告，页面 `scrollWidth` 与视口宽度一致。
- 四视口截图归档在 `.scratch/ui-atelier-desktop-optimization/evidence/ticket-07/`。
