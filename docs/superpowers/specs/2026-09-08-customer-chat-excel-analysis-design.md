# 客服聊天截图 Excel AI 解析中心设计

## 1. 目标

构建一个单用户内部工具，用于导入包含聊天截图的 Excel 文件，结合 Excel 中的辅助字段和可配置的解析提示词，调用 OpenAI 兼容视觉模型完成客服聊天分析，并导出保留原图、原始字段和解析字段的新 Excel 文件。

第一版重点验证完整工作流：

```text
导入 Excel -> 识别图片和字段 -> 配置解析板块 -> 调用 AI -> 人工复核 -> 导出 Excel
```

## 2. 范围

### 包含

- 导入 `.xlsx` 文件。
- 读取工作表、行数据、单元格字段和嵌入图片。
- 将一行中的辅助字段与图片关联为一条待解析记录。
- 按板块配置独立提示词和结构化输出字段。
- 配置多个 OpenAI 兼容模型。
- 服务端保存模型配置，并加密保存 API Key。
- 单条解析、批量解析、失败重试和解析状态展示。
- 原图、辅助字段、AI 结果并排查看。
- 人工编辑结果、标记复核状态、记录复核备注。
- 导出新的 Excel，保留原图、原字段并追加解析结果列。

### 不包含

- 用户登录、角色权限和多人协作。
- 云端对象存储。
- 复杂工作流编排。
- 自动训练或微调模型。
- OCR 独立服务。
- 生产级队列集群。

## 3. 技术架构

采用前后端一体化本地部署：

- 前端：React + Vite。
- 服务端：Node.js + Express。
- 数据库：SQLite。
- Excel 处理：使用支持工作簿读写和图片关系读取的成熟 Node.js 库；如库无法完整保留图片，则使用 OOXML ZIP 层读取和写回图片关系。
- AI 调用：服务端通过 OpenAI 官方 SDK 或兼容 HTTP 客户端调用 `chat/completions` 视觉接口。
- 配置加密：使用服务端环境变量提供的加密密钥，通过 AES-256-GCM 加密 API Key。
- 文件存储：默认存储在服务端 `data/` 目录，按任务划分子目录。

浏览器不直接调用模型服务。浏览器只访问本地应用服务端，模型 API Key 仅在服务端解密和发送。

## 4. 页面和交互

### 4.1 主工作台

- 顶部工具栏：
  - 导入 Excel。
  - 当前任务选择。
  - 解析板块选择。
  - 批量解析。
  - 导出 Excel。
  - 模型配置入口。
  - 板块配置入口。
- 左侧任务区域：
  - 任务列表。
  - 记录状态筛选：全部、待解析、解析中、已完成、需复核、失败。
  - 解析板块树，支持启用或停用。
- 中央记录区域：
  - 图片缩略图。
  - 原始辅助字段。
  - 当前解析状态。
  - 复核状态。
  - 选择记录查看详情。
- 右侧详情区域：
  - 原始聊天截图预览。
  - 辅助字段。
  - 结构化解析结果。
  - 人工修改入口。
  - 复核状态和备注。

### 4.2 模型配置

支持新增、编辑、删除和测试模型配置：

- 配置名称。
- Base URL。
- API Key。
- Model。
- 是否支持图片。
- Temperature。
- Max Tokens。
- 是否启用。
- 设为默认模型。

Key 默认显示脱敏值。编辑已有配置时不回传明文 Key；只有输入新 Key 时才更新密文。

测试连接使用最小图片请求或文本请求，并返回连接状态、模型响应耗时和错误原因，不展示密钥。

### 4.3 板块配置

板块采用一级分类和二级解析板块：

- 聊天问题
  - 接待流程质检
  - 未成交分析
  - 热点问题
- 产品问题
  - 退货分析

每个二级板块支持：

- 名称。
- 独立提示词。
- 输出字段定义。
- 排序。
- 启用状态。

用户可以新增一级或二级板块，修改提示词和输出字段。

## 5. 数据流

### 5.1 导入

1. 前端上传 `.xlsx`。
2. 服务端验证扩展名、文件大小和工作簿可读性。
3. 服务端读取工作表和行数据。
4. 服务端定位嵌入图片、图片所在单元格和相邻行。
5. 根据图片锚点将图片与行记录关联。
6. 每条记录保存原始工作表、行号、辅助字段和图片文件路径。
7. 创建任务并返回任务汇总。

图片关联优先使用图片锚点所在行；如果图片跨越多行，则使用起始行，并在记录中保存原始锚点信息以便复核。

### 5.2 AI 解析

1. 用户选择一个解析板块。
2. 服务端读取当前默认模型配置。
3. 创建解析运行记录，并保存模型配置快照、提示词快照和输出字段快照。
4. 服务端将图片转为兼容接口需要的 data URL 或 multipart 内容。
5. 服务端组合系统约束、板块提示词、辅助字段和图片内容。
6. 请求模型返回严格 JSON。
7. 服务端校验 JSON 字段和类型。
8. 保存结构化结果、原始响应、耗时、Token 信息和状态。
9. 前端刷新记录状态和结果。

模型请求的核心消息结构采用 OpenAI 兼容格式：

```json
{
  "model": "configured-model",
  "temperature": 0.2,
  "max_tokens": 1500,
  "response_format": { "type": "json_object" },
  "messages": [
    {
      "role": "system",
      "content": "你是客服质检分析助手，只返回合法 JSON。"
    },
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "板块提示词和辅助字段..." },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,..."
          }
        }
      ]
    }
  ]
}
```

对于不支持 `response_format` 的兼容服务，服务端仍会要求 JSON，并通过 JSON 解析和字段校验兜底。

### 5.3 复核

- AI 结果默认标记为“待复核”。
- 用户可直接修改字段值。
- 保存人工修改后记录修改时间和修改来源。
- 用户可以将记录标记为“已确认”或重新标记为“需复核”。
- 原始模型结果保持不变，人工结果单独保存。

### 5.4 导出

服务端基于原始工作簿生成新文件：

- 保留原工作表。
- 保留原始辅助字段。
- 尽量保留图片及其原有位置。
- 在对应工作表追加解析字段列。
- 对多板块结果使用板块前缀，避免同名字段冲突。
- 追加解析状态、复核状态、使用模型和解析时间。
- 对失败或缺失字段写入空值和状态，不覆盖原始数据。

示例列名：

```text
接待流程质检_结论
接待流程质检_问题类型
接待流程质检_置信度
未成交分析_原因
产品问题_问题描述
解析状态
复核状态
复核备注
```

## 6. 数据模型

### `model_configs`

- `id`
- `name`
- `base_url`
- `api_key_ciphertext`
- `model`
- `supports_vision`
- `temperature`
- `max_tokens`
- `is_default`
- `is_enabled`
- `created_at`
- `updated_at`

### `analysis_sections`

- `id`
- `parent_id`
- `name`
- `prompt`
- `output_schema_json`
- `sort_order`
- `is_enabled`
- `created_at`
- `updated_at`

### `jobs`

- `id`
- `original_filename`
- `source_path`
- `status`
- `total_records`
- `completed_records`
- `failed_records`
- `created_at`
- `updated_at`

### `records`

- `id`
- `job_id`
- `sheet_name`
- `row_number`
- `anchor_json`
- `source_fields_json`
- `image_path`
- `status`
- `review_status`
- `review_note`
- `human_result_json`
- `created_at`
- `updated_at`

### `analysis_runs`

- `id`
- `record_id`
- `section_id`
- `model_config_snapshot_json`
- `prompt_snapshot`
- `output_schema_snapshot_json`
- `model_result_json`
- `raw_response`
- `error_message`
- `duration_ms`
- `input_tokens`
- `output_tokens`
- `status`
- `created_at`

## 7. API

- `POST /api/jobs/import`
- `GET /api/jobs`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/records`
- `POST /api/records/:id/analyze`
- `POST /api/jobs/:id/analyze`
- `POST /api/records/:id/retry`
- `PATCH /api/records/:id`
- `GET /api/jobs/:id/export`
- `GET /api/model-configs`
- `POST /api/model-configs`
- `PATCH /api/model-configs/:id`
- `DELETE /api/model-configs/:id`
- `POST /api/model-configs/:id/test`
- `GET /api/sections`
- `POST /api/sections`
- `PATCH /api/sections/:id`
- `DELETE /api/sections/:id`

接口统一返回：

```json
{
  "success": true,
  "data": {},
  "error": null
}
```

失败时使用明确错误码和用户可读消息，服务端日志保留技术细节但不记录 API Key。

## 8. 错误和边界情况

- 文件格式不支持、文件损坏或超过大小限制：拒绝导入并说明原因。
- 工作簿没有图片：不创建任务，提示用户检查文件。
- 图片无法读取：创建记录并标记为图片读取失败。
- 图片与行无法唯一关联：保留锚点信息，标记需复核。
- 模型超时、限流或临时网络错误：有限次数重试。
- 模型返回非 JSON 或字段类型错误：保存原始响应并标记需复核。
- 批量任务中单条失败：不阻塞其他记录。
- 默认模型被删除或停用：阻止解析并提示先选择可用模型。
- 导出过程中部分记录未完成：显示确认提示，但允许导出。

## 9. 测试策略

### 服务端单元测试

- 解析 Excel 工作表和嵌入图片。
- 图片锚点到行记录的关联。
- OpenAI 兼容请求构造。
- JSON 提取与输出字段校验。
- API Key 加密、解密和脱敏。
- 默认模型配置切换。
- 导出列生成和状态映射。

### 服务端集成测试

- 导入文件后创建任务和记录。
- 单条解析保存配置快照。
- 批量解析允许部分失败。
- 人工复核结果不覆盖原始模型结果。
- 导出的工作簿包含原图和解析字段。

### 前端测试

- 上传和任务状态展示。
- 板块和模型配置表单。
- 单条解析、批量解析、重试。
- 原图和结果编辑。
- 空、加载、错误状态。

## 10. 非功能要求

- API Key 不进入浏览器响应、前端构建产物或日志。
- 解析任务可恢复，服务端重启后已保存记录不丢失。
- 默认限制上传文件大小，具体值通过环境变量配置。
- 解析并发数通过环境变量配置，默认低并发以控制模型费用和服务压力。
- 页面支持桌面端为主，并对窄屏提供基础可用布局。
- 解析过程显示进度、失败数和可重试入口。

## 11. 验收标准

1. 可以导入包含聊天截图的 Excel，并看到图片和辅助字段记录。
2. 可以在网页配置并测试 OpenAI 兼容模型。
3. 可以配置解析板块、提示词和输出字段。
4. 可以对单条或批量记录调用真实视觉模型。
5. 模型失败或返回异常时不会丢失原始数据，并能重试。
6. 可以人工修改和确认解析结果。
7. 导出的 Excel 保留原图、辅助字段和解析字段。
8. 服务端保存配置，前端不暴露 API Key 明文。
