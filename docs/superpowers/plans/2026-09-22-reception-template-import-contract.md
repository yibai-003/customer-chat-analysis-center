# Reception Template Import Contract Implementation Plan

**Goal:** Import reception-quality workbooks without analyzing placeholder rows or overwriting valid historical results.

**Architecture:** Store an explicit reception import contract in each immutable section-version business-rules snapshot. Migration 22 publishes a new current reception version carrying that contract. The streaming XLSX importer resolves the task-bound version, recognizes supported chat-screenshot anchors, classifies each image row as empty, complete historical, or conflicting, and validates the whole workbook before creating files or database rows.

## Tasks

- [x] Extend reception business rules with the screenshot column, result-area columns, and complete-history required columns.
- [x] Publish a migration-safe current reception version containing the import contract.
- [x] Add pure row-classification and conflict-reporting tests.
- [x] Integrate the contract into streaming preview/import while preserving generic section behavior.
- [x] Cover empty results, complete history, partial results, multiple worksheets, placeholder rows, and WPS-style XLSX anchors.
- [x] Verify source workbook bytes remain unchanged and task/version/platform bindings remain intact.
- [x] Run type checking, focused tests, full tests, build, and diff checks.
