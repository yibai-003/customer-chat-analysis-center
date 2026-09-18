# 12: 真实业务闭环与发布签字

**What to build:** 使用正式局域网环境和真实模型供应商凭据，完成一次导入、解析、复核、导出、审计、备份与独立恢复闭环，并据此关闭 Issue 07 的剩余发布条件。

**Blocked by:** 11: 真实局域网基础设施验收

**Status:** blocked-on-real-infrastructure (2026-09-18) — 闭环工具已就绪并在本机用桩模型验证，等待真实局域网、真实模型凭据与第二台工作站执行签署

- [ ] 管理员或配置人员通过正式界面配置真实模型供应商凭据，完成视觉与文本模型验证；凭据不会出现在前端响应、日志、审计或验收附件中。
- [ ] 操作人员从第二台局域网工作站导入一份脱敏但结构真实的 Excel，创建任务并成功完成至少一条包含模型调用的解析。
- [ ] 审核人员查看待复核记录、提交复核结论并导出审核结果；导出文件包含预期原始字段、解析字段、状态和复核信息。
- [ ] 只读人员可以查看共享任务和结果，但无法修改、复核、导出、配置模型或管理账号。
- [ ] 审计界面可通过关联 ID 追溯模型配置、导入、解析、复核、导出和权限拒绝，不包含密码、会话、API Key 或加密密钥。
- [ ] 管理员在无运行任务时创建完整备份，将匹配密钥安全放入独立恢复环境并执行恢复校验；恢复后的任务、图片、导出、知识配置和模型凭据可读取或解密。
- [ ] 使用 Issue 10 通过 CI 的镜像执行一次升级和回滚预演，确认持久数据不丢失且回滚步骤与运维文档一致。
- [ ] 更新 `docs/archive/lan-release-acceptance-2026-09-17.md` 或新增当日验收记录，补齐真实跨机、真实 CI、真实模型和恢复证据。
- [ ] 原 Issue 07 的所有复选项均有实际证据后，将其状态改为 `done`；任何真实 CI、跨机 HTTPS、模型解析或恢复校验未通过时不得签署发布通过。

**已就绪的实现（2026-09-18）：**
- `scripts/lan-acceptance-client.mjs` 新增 `real-model-configure` 与 `real-model-parse` 两步：
  - `real-model-configure` 用配置角色通过正式 API 创建视觉/文本模型、设为默认、做连通性检测、执行能力检测（文本/JSON/视觉）并将通过的成员加入模型池；重复执行会先清理上一次的验收模型，保证路由确定性。
  - `real-model-parse` 创建临时板块与单字段、以操作人员身份导入 `sample-chat.xlsx`、执行一次单条解析，断言字段返回模型输出且模型池记录了成功用量事件；全程校验模型响应、记录详情与用量事件不含真实 API Key，结束后清理临时板块字段。
  - 未提供模型凭据时两步记录为 `skipped`，演练模式不受影响；提供后审计的必查动作新增 `config.test_model`、`config.set_default_model`、`pool.verify`。
- `scripts/verify-lan-acceptance.ps1` 新增 `-ModelBaseUrl/-ModelApiKey/-ModelName/-TextModelName/-ModelSupportsVision/-RequireRealModel`，在演练与现场模式转发模型环境变量，并把 `realModel` 与 `modelEvidence` 写入证据；现场模式加 `-RequireRealModel` 时缺少凭据直接失败。
- 新增 `scripts/lan-acceptance-stub-model.mjs`：OpenAI 兼容桩模型，用于提交真实 Key 前预演闭环（探测值 `OK`/`{"ok":true}`/`red`，解析返回占位结论）；仅供预演，不得作为签署证据。
- [局域网现场验收执行手册](../../../docs/guides/lan-acceptance-runbook.md) 步骤 5 更新为携带真实模型参数的命令，并新增 5.1 桩模型预演小节与通过标准（`tlsVerified: true`、`realModel.configured: true`、至少一次真实模型调用成功）。
- 本机验证：桩模型下 `scripts/verify-lan-acceptance.ps1` 全流程 `ACCEPTANCE OK`，`real-model-parse` 记录一次模型调用成功（`recordStatus: completed`、30 tokens）；不提供模型时演练模式仍 `ACCEPTANCE OK` 且两步 `skipped`。
- 升级/回滚预演（第 7 项）已在演练模式中由脚本覆盖（换标签重建→数据保留→切回原标签），现场版本替换 Issue 10 的 CI 镜像标签即可；真实镜像标签与主机重启证据仍需现场执行。
- 待现场执行：第 1–6、8 项依赖内网 CA/DNS/防火墙、第二台物理工作站与真实模型凭据，`docs/archive/lan-release-acceptance-2026-09-17.md` 的补记与 Issue 07 状态变更须在真实证据齐备后进行，故工单保持未完成。

