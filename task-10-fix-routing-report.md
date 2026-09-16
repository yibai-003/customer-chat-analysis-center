# Task 10 路由最终审查修复报告

日期：2026-09-16

状态：DONE

## 修改范围

- `src/server/services/model-pool-service.ts`
- `src/server/services/model-pool-service.test.ts`
- `src/server/services/knowledge/knowledge-match-service.ts`
- `src/server/services/knowledge/knowledge-match-service.test.ts`
- `src/server/services/field-analysis-service.ts`
- `src/server/services/field-analysis-service.test.ts`
- `task-10-fix-routing-report.md`

未修改迁移、能力 TTL/ready 逻辑或 UI 文件。

## 修复内容

### 1. 付费 attempt reservation 生命周期

- transport 成功后不再提前结算。
- 每个 attempt 通过一次性 `settle` 在最终状态结算批次额度。
- 成功、invalid output、同模型重试、模型切换、取消和 transport 异常都会释放持久化 reservation。
- invalid output 仍按实际合法 usage 计费；usage 未知时按 `maxTokens` 预留值计费。
- reservation 释放与 attempt 终态绑定，避免重试和切换遗留日/月预留。

### 2. transport 返回后的取消检查

- transport 返回后、本地校验前检查取消。
- 本地校验后、成功记账前再次检查取消。
- 迟到成功被取消时：
  - 不写 success 事件。
  - 不写 usage_unknown 事件。
  - 付费批次额度按 0 结算。
  - 释放持久化 reservation。
  - 只记录 cancelled failure，且不切换模型。

### 3. usage 完整性

- 只有 `prompt_tokens` 和 `completion_tokens` 都是合法非负安全整数时，usage 才是 known。
- 任一字段缺失、负数或非整数时均写入 `usage_unknown`。
- 免费模型未知 usage 不扣免费额度，accounted token 为 0。
- 付费模型未知 usage 按 `maxTokens` 预留值计入批次与持久化用量。

### 4. knowledge match 统一路由校验与字段快照

- 将以下协议校验传给 `callModelPool.validate`：
  - 返回内容可解析为 JSON 对象。
  - `knowledgeItemId` 必须是字符串。
  - ID 必须为空字符串或属于当前候选集合。
- 非法 JSON、错误类型和候选范围外 ID 统一走模型池的 invalid-output 重试与切换。
- knowledge match 返回实际 route，field run 持久化：
  - routed model ID、名称、模型名和 purpose。
  - 全部 attempts。
  - raw response。
  - prompt/completion usage。
- 合法空 ID 的 needs-review 结果同样保留 route 元数据。
- 缓存命中保持原有 key 和 TTL，不再次调用模型；field run 明确标记 cached，且不重复写模型 usage。

## TDD 记录

首次新增测试时观察到以下预期失败：

- 两次付费 invalid output 后切换成功，持久化 reservation 仍残留 200。
- transport 返回成功但 signal 已取消时，调用错误地成功完成。
- 只有 `prompt_tokens` 时，免费额度被错误扣减 12。
- 缺失、负数或小数 token usage 未统一按 unknown 处理。
- knowledge match 未向模型池传入 validate。
- knowledge match 结果未返回 route。
- knowledge field run 的模型快照只有 `{ "purpose": "text" }`。
- 合法空候选 ID 的 needs-review 结果丢失 route 元数据。

实现后上述测试全部转绿，并增加缓存命中回归测试。

## 验证结果

### 定向测试

命令：

```powershell
npm test -- src/server/services/model-pool-service.test.ts src/server/services/knowledge/knowledge-match-service.test.ts src/server/services/field-analysis-service.test.ts
```

结果：3 个测试文件通过，49 个测试通过。

### TypeScript

命令：

```powershell
npm run typecheck
```

结果：通过，退出码 0。

### 完整测试

命令：

```powershell
npm test
```

结果：72 个测试文件通过，537 个测试通过。

## 并行工作树说明

实施期间同一功能工作树存在其他任务的并行改动和提交。本任务提交仅暂存上述限定文件与本报告，不包含其他任务文件。
