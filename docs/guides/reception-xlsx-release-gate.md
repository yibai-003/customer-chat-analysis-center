# 接待质检真实 XLSX 发布门禁

> 当前基准：2026-09-23  
> 对应工单：07「真实 XLSX 端到端验收与版本回退发布门禁」

## 自动化门禁

运行：

```powershell
npm run gate:reception-xlsx
```

不指定样本时，门禁会生成确定性的脱敏真实风格工作簿，用于持续集成和自动化回归。该合成工作簿不能作为正式发布所要求的“脱敏真实文件”证据。

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

## 正式发布候选

准备一份已经脱敏、由 WPS 保存并覆盖规定场景的真实业务工作簿，然后使用固定工件目录运行：

```powershell
npm run gate:reception-xlsx -- --artifact-dir=.\artifacts\reception-xlsx\release-candidate --real-sample=.\private-samples\reception-real-anonymized-wps.xlsx
```

真实样本不会提交到 Git；候选记录会保存其来源路径、工件副本和 SHA-256。若样本结构或场景不满足契约，专项端到端测试会失败。

## Excel/WPS 人工证据

使用上述候选目录中的同一个导出文件，分别在 Microsoft Excel 和 WPS 表格中打开，检查工作表、图片、样式、公式、行数、预留行和目标字段。计算样本和导出文件的 SHA-256，然后保存如下 JSON：

```json
{
  "sample": {
    "anonymizedReal": true,
    "wpsProduced": true,
    "operator": "验收人",
    "checkedAt": "2026-09-23T11:50:00+08:00",
    "sampleFile": "reception-quality-anonymized.xlsx",
    "sampleFileSha256": "<样本文件 SHA-256>",
    "notes": "来源为脱敏真实接待质检文件，并由 WPS 保存"
  },
  "excel": {
    "opened": true,
    "operator": "验收人",
    "checkedAt": "2026-09-23T12:00:00+08:00",
    "exportFile": "reception-quality-anonymized-export.xlsx",
    "exportFileSha256": "<导出文件 SHA-256>",
    "notes": "图片、样式、公式、行数和字段正常"
  },
  "wps": {
    "opened": true,
    "operator": "验收人",
    "checkedAt": "2026-09-23T12:10:00+08:00",
    "exportFile": "reception-quality-anonymized-export.xlsx",
    "exportFileSha256": "<同一导出文件 SHA-256>",
    "notes": "图片、样式、公式、行数和字段正常"
  }
}
```

执行正式发布门禁：

```powershell
npm run release:reception-xlsx -- --artifact-dir=.\artifacts\reception-xlsx\release-candidate --manual-evidence=.\manual-evidence.json
```

正式放行不会重新生成 XLSX，而是校验候选目录中样本和导出文件的 SHA-256，并要求各项 `checkedAt` 不早于候选记录的 `generatedAt`，确保人工检查与自动化检查针对完全相同的文件且发生在候选生成之后。只有外部脱敏真实/WPS 样本、自动化检查和 Excel/WPS 两项证据全部通过时，最终 `acceptance-record.json` 的 `officialReleaseEligible` 才会是 `true`。

## CI 边界

CI 在干净检出上运行专项端到端验收并上传自动化验收工件。Excel/WPS 桌面程序不在 Linux runner 内运行，因此 CI 工件明确标记人工证据待补；正式发布仍必须在可用的桌面环境中执行上述人工证据门禁。
