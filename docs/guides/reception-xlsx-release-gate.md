# 接待质检真实 XLSX 发布门禁

> 当前基准：2026-09-23  
> 对应工单：07「真实 XLSX 端到端验收与版本回退发布门禁」

## 自动化门禁

运行：

```powershell
npm run gate:reception-xlsx
```

门禁会生成确定性的脱敏真实风格工作簿，覆盖无平台列、无问题、单问题、多问题、D 级、待复核、缺少可靠会话时间、完整历史结果、部分结果冲突和无图片预留行。

随后执行：

1. XLSX 预览与导入；
2. 当前版本绑定和平台绑定；
3. 受控视觉模型、统一质检模型分析；
4. 已完成及待复核记录的会话 ID 派发；
5. 激活历史版本并导入第二个任务；
6. 重试第一个任务，校验版本、知识快照、业务规则、质检结果和会话 ID 不变；
7. 导出并通过 ExcelJS 与 OOXML 包结构重新读取；
8. 全量自动化测试、类型检查和生产构建。

输出位于 `artifacts/reception-xlsx/<时间>/`，包括：

- `reception-quality-anonymized.xlsx`
- `reception-quality-partial-conflict.xlsx`
- `reception-quality-anonymized-export.xlsx`
- `automated-acceptance.json`
- `acceptance-record.json`

自动化门禁成功只代表发布候选通过程序验证；在 Excel 和 WPS 的人工打开证据补齐前，记录中的 `officialReleaseEligible` 保持 `false`。

## Excel/WPS 人工证据

使用门禁生成的同一个导出文件，分别在 Microsoft Excel 和 WPS 表格中打开，检查工作表、图片、样式、公式、行数、预留行和目标字段，然后保存如下 JSON：

```json
{
  "excel": {
    "opened": true,
    "operator": "验收人",
    "checkedAt": "2026-09-23T12:00:00+08:00",
    "exportFile": "reception-quality-anonymized-export.xlsx",
    "notes": "图片、样式、公式、行数和字段正常"
  },
  "wps": {
    "opened": true,
    "operator": "验收人",
    "checkedAt": "2026-09-23T12:10:00+08:00",
    "exportFile": "reception-quality-anonymized-export.xlsx",
    "notes": "图片、样式、公式、行数和字段正常"
  }
}
```

执行正式发布门禁：

```powershell
npm run release:reception-xlsx -- --manual-evidence=.\manual-evidence.json
```

只有自动化检查全部通过且 Excel/WPS 两项证据完整时，最终 `acceptance-record.json` 的 `officialReleaseEligible` 才会是 `true`。任一检查失败、证据缺失或格式不完整时命令返回非零状态，不得标记功能完成或进入正式发布。

## CI 边界

CI 在干净检出上运行专项端到端验收并上传自动化验收工件。Excel/WPS 桌面程序不在 Linux runner 内运行，因此 CI 工件明确标记人工证据待补；正式发布仍必须在可用的桌面环境中执行上述人工证据门禁。
