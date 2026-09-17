# 大文件 Excel 处理流程方案

> 文档日期：2026-09-10  
> 适用场景：6000 行左右、每行包含 1 张聊天截图、原始 Excel 约 800 MB 的退货分析文件。

## 1. 目标

将当前的同步处理方式升级为可处理大文件的后台任务流程：

```text
分片上传
→ 文件合并
→ Excel 结构预检
→ 后台提取图片和辅助字段
→ 分批写入记录
→ 创建解析队列
→ 按字段依赖解析
→ 人工复核
→ 后台导出
```

核心目标：

- 上传过程支持断点续传。
- 大文件导入不阻塞 HTTP 请求。
- 图片不一次性全部加载到内存。
- 导入、解析、导出都有独立状态和进度。
- 服务重启后可以继续未完成任务。
- 单张图片或单条记录失败不影响其他记录。
- 支持失败记录单独重试。

## 2. 当前问题

当前流程是：

```text
上传 Excel
→ workbook.xlsx.readFile()
→ 一次性读取整个工作簿和全部图片
→ 全部图片写入磁盘
→ 一次性创建任务和记录
→ 返回上传结果
```

该方式不适合 800 MB 级别文件，主要风险：

- ExcelJS 一次性占用大量内存。
- HTTP 请求持续时间过长，容易超时。
- 导入失败时难以恢复到具体行。
- 文件、图片和数据库记录可能只完成一部分。
- 多个大任务同时运行时会争抢内存。
- 导出重新加载完整工作簿，同样存在内存压力。

## 3. 总体架构

```text
浏览器
  │
  ├─ 1. 创建上传任务
  │       ↓
  ├─ 2. 分片上传
  │       ↓
  ├─ 3. 合并并校验文件
  │       ↓
  └─ 4. 轮询任务状态

服务端
  │
  ├─ Upload Service
  │     └─ 分片保存、合并、Hash 校验
  │
  ├─ Import Worker
  │     └─ 工作簿预检、图片提取、记录分批写入
  │
  ├─ Analysis Worker
  │     └─ 按记录和字段依赖执行 AI 解析
  │
  ├─ Export Worker
  │     └─ 生成结果 Excel
  │
  └─ SQLite
        └─ 保存任务、记录、字段运行和进度
```

单用户版本可以先使用同一个 Node.js 进程，通过后台 Promise 队列运行。后续数据量继续增加时，再将 Worker 拆成独立进程。

## 4. 文件目录

```text
data/
  uploads/
    {uploadId}/
      chunks/
        000001.part
        000002.part
      merged.xlsx

  jobs/
    {jobId}/
      source.xlsx
      images/
        original/
          000001.png
          000002.jpg
        thumb/
          000001.jpg
          000002.jpg
        ai/
          000001.jpg
          000002.jpg
      import-manifest.json

  exports/
    {exportJobId}/
      result.xlsx
```

文件规则：

- `source.xlsx` 保存原始工作簿，供最终导出使用。
- `original` 保存原图，用于详情页和原图保留。
- `thumb` 用于列表缩略图，限制尺寸和质量。
- `ai` 用于发送给视觉模型，限制尺寸和文件大小。
- 数据库只保存路径、Hash、大小、行号和处理状态，不保存图片 Base64。

## 5. 上传流程

### 5.1 创建上传任务

用户选择文件后，前端先请求：

```http
POST /api/uploads
```

请求信息：

```json
{
  "filename": "退货分析_测试.xlsx",
  "size": 838860800,
  "fileHash": "sha256...",
  "sectionId": "refund",
  "chunkSize": 16777216,
  "chunkCount": 50
}
```

服务端返回：

```json
{
  "uploadId": "upload-uuid",
  "status": "uploading",
  "uploadedChunks": []
}
```

### 5.2 分片上传

```http
PUT /api/uploads/{uploadId}/chunks/{chunkIndex}
Content-Type: application/octet-stream
```

建议参数：

```text
分片大小：8 - 16 MB
并发上传：2 - 4 个
失败重试：最多 3 次
```

每个分片上传成功后，服务端返回：

```json
{
  "chunkIndex": 0,
  "received": true,
  "size": 16777216
}
```

### 5.3 断点续传

浏览器重新打开页面时请求：

```http
GET /api/uploads/{uploadId}
```

服务端返回已经完成的分片列表。前端只上传缺失分片，不重新上传完整文件。

### 5.4 合并文件

所有分片上传完成后：

```http
POST /api/uploads/{uploadId}/complete
```

服务端执行：

```text
检查分片数量
→ 按顺序合并
→ 校验文件大小
→ 校验 SHA-256
→ 检查 ZIP/XLSX 结构
→ 创建导入任务
```

合并成功后删除分片文件，只保留合并后的 `merged.xlsx`。

## 6. 导入预检流程

导入预检不创建记录，不提取全部图片，只检查基础结构：

```text
读取工作簿结构
→ 获取工作表名称
→ 读取第一行表头
→ 统计图片数量
→ 检查图片锚点是否有效
→ 检查解析板块必需字段
→ 返回预检结果
```

预检结果示例：

```json
{
  "sheetCount": 1,
  "imageCount": 6000,
  "estimatedRecords": 6000,
  "missingHeaders": [],
  "invalidImageCount": 0,
  "warnings": [
    "文件较大，正式导入将在后台执行"
  ]
}
```

页面显示：

```text
文件名：退货分析_测试.xlsx
文件大小：800 MB
工作表：1
预计记录：6000
嵌入图片：6000
当前板块：退货分析
状态：可以导入
```

只有预检通过后才允许开始正式导入。

## 7. 后台导入流程

### 7.1 创建导入任务

```http
POST /api/import-jobs
```

返回：

```json
{
  "importJobId": "import-job-uuid",
  "jobId": "analysis-job-uuid",
  "status": "queued"
}
```

接口不等待导入完成。

### 7.2 导入状态

```text
queued
  ↓
preparing
  ↓
extracting
  ↓
writing
  ↓
completed
```

异常状态：

```text
failed
cancelled
```

### 7.3 图片和记录分批处理

建议每批处理：

```text
图片提取批次：100 - 300 张
数据库写入批次：200 - 500 条
单批事务：一个 SQLite transaction
```

每张图片处理步骤：

```text
读取图片媒体
→ 校验非空
→ 写入 original
→ 生成 thumb
→ 生成 ai 图片
→ 计算图片 Hash
→ 记录工作表、行号、锚点和辅助字段
→ 释放当前图片引用
```

每批完成后更新：

```text
processedImages
processedRecords
failedImages
currentSheet
currentRow
updatedAt
```

### 7.4 导入进度接口

```http
GET /api/import-jobs/{id}
```

返回：

```json
{
  "status": "extracting",
  "totalImages": 6000,
  "processedImages": 2350,
  "failedImages": 2,
  "totalRecords": 6000,
  "processedRecords": 2348,
  "currentSheet": "Sheet1",
  "currentRow": 2351,
  "errorMessage": null
}
```

## 8. 解析流程

导入完成后才创建解析队列：

```text
导入完成
→ 创建 6000 条待解析记录
→ 分批领取记录
→ 执行字段依赖链
→ 保存字段结果
→ 更新记录状态
→ 继续下一批
```

### 8.1 记录状态

```text
pending
  ↓
processing
  ↓
completed
needs_review
failed
```

任务状态：

```text
ready
processing
paused
completed
failed
cancelled
```

### 8.2 单条记录字段链

退货分析示例：

```text
截图内容
  │
  ├─ 视觉模型解析 1 次
  │
  ↓
知识库匹配
  │
  ├─ 文本模型匹配 1 次
  │
  ↓
一级选项
  │
  └─ 从知识库匹配结果提取
  ↓
二级选项
  │
  └─ 从知识库匹配结果提取
  ↓
三级选项
     └─ 从知识库匹配结果提取
```

原则：

- 同一条记录的截图只按需读取一次。
- 不让一级、二级、三级字段重复调用视觉模型。
- 知识库匹配失败只影响当前记录。
- 模型失败进入重试队列。
- 超过重试次数后标记为 `failed`，交由人工处理。

### 8.3 模型并发建议

初始配置：

```text
视觉模型并发：2
文本模型并发：4
单记录最大重试：3 次
429 重试等待：指数退避
超时：90 秒
```

实际并发需要根据模型供应商限流和服务器资源压测后调整。

## 9. 断点恢复

服务重启后：

```text
查询 status = processing 的导入任务
→ 检查最后处理位置
→ 检查已存在的图片文件和记录
→ 跳过已完成内容
→ 继续处理未完成部分
```

解析任务恢复：

```text
查询 status = processing 的解析任务
→ 将 processing 记录恢复为 pending
→ 保留已完成和需复核结果
→ 继续领取 pending 记录
```

每条记录需要保存：

```text
processing_started_at
worker_token
retry_count
last_error
```

防止服务异常退出后记录永久卡在 `processing`。

## 10. 暂停、取消和重试

### 暂停

```text
任务状态改为 paused
→ 不再领取新记录
→ 已经进行中的模型请求允许完成
→ 保存当前进度
```

### 取消

```text
任务状态改为 cancelled
→ 不再领取新记录
→ 清理未完成的临时资源
→ 保留已经完成的记录和错误信息
```

### 重试失败

```text
筛选 status = failed 的记录
→ retry_count + 1
→ 恢复为 pending
→ 重新加入解析队列
```

不能因为重试失败记录而重新解析已完成记录。

## 11. 导出流程

导出也使用后台任务：

```http
POST /api/export-jobs
```

返回：

```json
{
  "exportJobId": "export-job-uuid",
  "status": "queued"
}
```

后台流程：

```text
读取原始工作簿
→ 按工作表处理
→ 写入解析字段
→ 写入复核结果
→ 保留原始图片
→ 写入临时导出文件
→ 校验文件可打开
→ 移动为最终导出文件
```

导出状态：

```text
queued
processing
completed
failed
```

导出进度：

```text
已处理工作表
已处理记录
总记录数
当前工作表
文件大小
错误信息
```

对于 800 MB 原始文件，第一版可以继续使用 ExcelJS，但必须放在后台任务中，并限制同时导出的任务数量为 1。后续再优化为直接修改 XLSX 压缩包内部 XML，减少图片重复加载。

## 12. 数据库建议

新增或完善以下表：

### upload_jobs

```text
id
filename
file_size
file_hash
chunk_size
chunk_count
uploaded_chunks_json
status
created_at
updated_at
```

### import_jobs

```text
id
job_id
status
total_images
processed_images
failed_images
total_records
processed_records
current_sheet
current_row
error_message
created_at
updated_at
```

### analysis_records_queue

```text
id
job_id
record_id
status
worker_token
retry_count
last_error
locked_at
completed_at
```

### export_jobs

```text
id
job_id
section_ids_json
status
processed_records
total_records
output_path
error_message
created_at
updated_at
```

建议索引：

```sql
CREATE INDEX idx_records_job_status
ON records(job_id, status);

CREATE INDEX idx_analysis_queue_status
ON analysis_records_queue(status, locked_at);

CREATE INDEX idx_import_jobs_status
ON import_jobs(status);

CREATE INDEX idx_export_jobs_status
ON export_jobs(status);
```

## 13. 内存和并发控制

单用户版本建议限制：

```text
同时上传任务：1
同时导入任务：1
同时解析任务：1
同时导出任务：1
视觉模型并发：2
文本模型并发：4
```

如果导入和解析同时执行，需要保证：

```text
导入未完成的任务不能进入解析
同一任务不能同时导入和导出
同一任务不能重复启动解析
```

图片内存控制：

- 每次只处理当前批次图片。
- 图片写盘后立即释放 Buffer。
- 不把所有图片挂在全局数组中。
- 生成缩略图和 AI 图片后释放中间对象。
- 页面列表只加载缩略图。
- 原图点击后再加载。

## 14. 压测方案

### 测试数据

```text
100 行
1000 行
3000 行
6000 行
10000 行
```

图片平均大小：

```text
50 KB
136 KB
300 KB
500 KB
```

### 导入测试指标

```text
上传耗时
合并耗时
预检耗时
正式导入耗时
峰值内存
峰值 CPU
数据库大小
图片目录大小
失败图片数
```

### 解析测试指标

```text
单条平均耗时
整体吞吐量
视觉模型请求数
文本模型请求数
模型失败率
429 次数
重试次数
需复核记录数
```

### 导出测试指标

```text
导出耗时
峰值内存
峰值 CPU
导出文件大小
Excel 是否可以正常打开
原图数量是否完整
结果字段是否完整
```

## 15. 验收标准

6000 行、约 800 MB 文件达到以下条件后，才认为大文件流程可用：

- 上传支持断点续传。
- 上传中断后可以继续，不需要从头开始。
- 导入接口不会等待全部图片处理完成。
- 导入过程中页面可以查看实时进度。
- 服务端内存不会随已处理图片数量持续无限增长。
- 单张坏图不会导致整份文件失败。
- 服务重启后可以继续导入。
- 解析任务可以暂停、取消和恢复。
- 失败记录可以单独重试。
- 导出过程不会阻塞页面其他操作。
- 导出的 Excel 可以正常打开。
- 原始图片数量和原始工作表结构保持完整。

## 16. 推荐实施顺序

### 阶段一：大文件上传

```text
分片上传
→ 断点续传
→ 文件合并
→ Hash 校验
```

### 阶段二：异步导入

```text
导入任务表
→ 后台导入
→ 分批图片处理
→ 分批写入数据库
→ 导入进度页
```

### 阶段三：解析队列

```text
记录队列
→ 领取锁
→ 并发控制
→ 失败重试
→ 断点恢复
```

### 阶段四：异步导出

```text
导出任务
→ 后台生成
→ 进度显示
→ 文件校验
→ 下载
```

### 阶段五：真实文件压测

```text
1000 行
→ 3000 行
→ 6000 行
→ 10000 行
```

每阶段都要记录内存、耗时、失败率和磁盘占用，再决定下一阶段的并发参数。

## 17. 第一版建议取舍

为了保持代码简洁，第一版不引入 Redis、消息队列或对象存储，采用：

```text
SQLite
本地文件系统
Node.js 后台任务管理器
```

第一版优先保证：

- 不崩溃。
- 可恢复。
- 可观察。
- 可重试。
- 数据不丢失。

当出现以下情况时，再升级到 Redis 或独立 Worker：

- 同时需要处理多个 800 MB 文件。
- 需要多台服务器共同处理。
- AI 解析任务持续运行数小时以上。
- 需要多个用户同时操作。
- 本地磁盘无法满足图片存储量。
