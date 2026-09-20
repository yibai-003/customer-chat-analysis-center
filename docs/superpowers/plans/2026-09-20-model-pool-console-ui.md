# Model Pool Console UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make model identity, selection, and quota state easier to scan while preserving native accessibility, existing APIs, and all model-pool operations.

**Architecture:** Small model-pool-specific modules own quota normalization, quota rendering, and native tri-state checkbox behavior. `PoolView` composes those modules and retains all request/state logic; existing CSS receives scoped model-pool styles without changing application-wide controls.

**Tech Stack:** React 19, TypeScript 7, Testing Library, Vitest 4, existing CSS design tokens.

**Spec:** `docs/superpowers/specs/2026-09-20-model-pool-console-ui-design.md`

## Global Constraints

- Do not change model-pool API request or response shapes.
- Do not change model routing, priority, permissions, verification, removal, restore, or edit behavior.
- Keep native `input[type="checkbox"]` semantics and keyboard operation.
- Keep the horizontal table; do not replace rows with cards or hide columns.
- Preserve exact token values next to any visual quota indicator.
- Real four-viewport screenshots remain acceptance work.

---

### Task 1: Quota Presentation Model

**Files:**
- Create: `src/client/components/model-config/quota-presentation.ts`
- Create: `src/client/components/model-config/quota-presentation.test.ts`

**Interfaces:**
- Produces: `QuotaPresentation`
- Produces: `quotaPresentation(model: QuotaInput): QuotaPresentation`
- Produces: `formatQuotaTokens(value: number): string`

- [ ] **Step 1: Write failing quota normalization tests**

Create `src/client/components/model-config/quota-presentation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { quotaPresentation } from "./quota-presentation";

describe("quota presentation", () => {
  it("returns normal and warning states around the safety threshold", () => {
    expect(quotaPresentation({
      quotaUsedTokens: 800,
      quotaTotalTokens: 1000,
      quotaSafetyRatio: 0.9,
      quotaBlocked: false,
    })).toMatchObject({ kind: "finite", tone: "normal", percent: 80 });
    expect(quotaPresentation({
      quotaUsedTokens: 900,
      quotaTotalTokens: 1000,
      quotaSafetyRatio: 0.9,
      quotaBlocked: false,
    })).toMatchObject({ kind: "finite", tone: "warning", percent: 90 });
  });

  it("treats blocked, exhausted and overused quotas as exhausted", () => {
    for (const input of [
      { quotaUsedTokens: 1000, quotaTotalTokens: 1000, quotaSafetyRatio: 0.9, quotaBlocked: false },
      { quotaUsedTokens: 1200, quotaTotalTokens: 1000, quotaSafetyRatio: 0.9, quotaBlocked: false },
      { quotaUsedTokens: 200, quotaTotalTokens: 1000, quotaSafetyRatio: 0.9, quotaBlocked: true },
    ]) {
      expect(quotaPresentation(input)).toMatchObject({
        kind: "finite",
        tone: "exhausted",
        percent: input.quotaUsedTokens >= 1000 ? 100 : 20,
      });
    }
  });

  it("handles unlimited and invalid totals without throwing", () => {
    expect(quotaPresentation({
      quotaUsedTokens: 50,
      quotaTotalTokens: null,
      quotaSafetyRatio: 0.9,
      quotaBlocked: false,
    })).toMatchObject({ kind: "unlimited", tone: "unlimited", total: null });

    for (const total of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(quotaPresentation({
        quotaUsedTokens: 50,
        quotaTotalTokens: total,
        quotaSafetyRatio: 0.9,
        quotaBlocked: false,
      })).toMatchObject({ kind: "invalid", tone: "invalid", percent: 0 });
    }
  });

  it("normalizes invalid or negative usage to zero", () => {
    for (const used of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(quotaPresentation({
        quotaUsedTokens: used,
        quotaTotalTokens: 1000,
        quotaSafetyRatio: 0.9,
        quotaBlocked: false,
      })).toMatchObject({ used: 0, percent: 0, tone: "normal" });
    }
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npx vitest run src/client/components/model-config/quota-presentation.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement quota normalization**

Create `quota-presentation.ts`:

```ts
export type QuotaTone = "normal" | "warning" | "exhausted" | "unlimited" | "invalid";
export type QuotaKind = "finite" | "unlimited" | "invalid";

export interface QuotaInput {
  quotaUsedTokens: number;
  quotaTotalTokens?: number | null;
  quotaSafetyRatio: number;
  quotaBlocked: boolean;
}

export interface QuotaPresentation {
  kind: QuotaKind;
  tone: QuotaTone;
  used: number;
  total: number | null;
  remaining: number | null;
  percent: number;
  statusText: string;
}

function nonNegativeFinite(value: number) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function formatQuotaTokens(value: number) {
  return new Intl.NumberFormat("zh-CN").format(nonNegativeFinite(value));
}

export function quotaPresentation(input: QuotaInput): QuotaPresentation {
  const used = nonNegativeFinite(input.quotaUsedTokens);
  if (input.quotaTotalTokens == null) {
    return {
      kind: "unlimited",
      tone: "unlimited",
      used,
      total: null,
      remaining: null,
      percent: 0,
      statusText: "不限额",
    };
  }
  const total = input.quotaTotalTokens;
  if (!Number.isFinite(total) || total <= 0) {
    return {
      kind: "invalid",
      tone: "invalid",
      used,
      total: null,
      remaining: null,
      percent: 0,
      statusText: "额度数据异常",
    };
  }
  const ratio = Math.min(1, used / total);
  const percent = Math.round(ratio * 100);
  const threshold = Number.isFinite(input.quotaSafetyRatio)
    ? Math.min(1, Math.max(0, input.quotaSafetyRatio))
    : 0.95;
  const tone = input.quotaBlocked || used >= total
    ? "exhausted"
    : ratio >= threshold
      ? "warning"
      : "normal";
  return {
    kind: "finite",
    tone,
    used,
    total,
    remaining: Math.max(0, total - used),
    percent,
    statusText: tone === "exhausted"
      ? "额度已耗尽"
      : tone === "warning"
        ? "接近安全阈值"
        : "额度正常",
  };
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```powershell
npx vitest run src/client/components/model-config/quota-presentation.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/client/components/model-config/quota-presentation.ts src/client/components/model-config/quota-presentation.test.ts
git commit -m "test: define model quota presentation states"
```

---

### Task 2: Native Tri-State Pool Checkbox

**Files:**
- Create: `src/client/components/model-config/PoolCheckbox.tsx`
- Create: `src/client/components/model-config/PoolCheckbox.test.tsx`

**Interfaces:**
- Produces: `PoolCheckbox(props)`
- Props: `label`, `checked`, `indeterminate?`, `disabled?`, `onChange`

- [ ] **Step 1: Write failing component tests**

Create `PoolCheckbox.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PoolCheckbox } from "./PoolCheckbox";

afterEach(cleanup);

describe("PoolCheckbox", () => {
  it("keeps native checkbox semantics and forwards changes", () => {
    const onChange = vi.fn();
    render(<PoolCheckbox label="选择成员 A" checked={false} onChange={onChange} />);
    const checkbox = screen.getByRole("checkbox", { name: "选择成员 A" });
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("sets and clears the native indeterminate property", () => {
    const { rerender } = render(
      <PoolCheckbox label="全选" checked={false} indeterminate onChange={() => undefined} />,
    );
    const checkbox = screen.getByRole("checkbox", { name: "全选" }) as HTMLInputElement;
    expect(checkbox.indeterminate).toBe(true);
    rerender(<PoolCheckbox label="全选" checked onChange={() => undefined} />);
    expect(checkbox.indeterminate).toBe(false);
    expect(checkbox.checked).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npx vitest run src/client/components/model-config/PoolCheckbox.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the component**

Create `PoolCheckbox.tsx`:

```tsx
import { useEffect, useRef } from "react";

export function PoolCheckbox({
  label,
  checked,
  indeterminate = false,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      className="pool-checkbox"
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```powershell
npx vitest run src/client/components/model-config/PoolCheckbox.test.tsx
```

Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/client/components/model-config/PoolCheckbox.tsx src/client/components/model-config/PoolCheckbox.test.tsx
git commit -m "feat: add accessible model pool checkbox"
```

---

### Task 3: Accessible Quota Meter

**Files:**
- Create: `src/client/components/model-config/QuotaMeter.tsx`
- Create: `src/client/components/model-config/QuotaMeter.test.tsx`

**Interfaces:**
- Produces: `QuotaMeter({ modelName, quota })`
- Consumes: `QuotaPresentation`

- [ ] **Step 1: Write failing rendering tests**

Create `QuotaMeter.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { quotaPresentation } from "./quota-presentation";
import { QuotaMeter } from "./QuotaMeter";

afterEach(cleanup);

describe("QuotaMeter", () => {
  it("renders exact finite values with progress semantics", () => {
    render(<QuotaMeter
      modelName="千问视觉"
      quota={quotaPresentation({
        quotaUsedTokens: 880_685,
        quotaTotalTokens: 1_000_000,
        quotaSafetyRatio: 0.95,
        quotaBlocked: false,
      })}
    />);
    expect(screen.getByText("880,685 / 1,000,000")).toBeTruthy();
    const progress = screen.getByRole("progressbar", { name: "千问视觉额度 88%" });
    expect(progress.getAttribute("aria-valuenow")).toBe("880685");
    expect(progress.getAttribute("aria-valuemax")).toBe("1000000");
  });

  it("caps overused progress semantics at max while preserving exact display", () => {
    render(<QuotaMeter
      modelName="超额模型"
      quota={quotaPresentation({
        quotaUsedTokens: 1_200_000,
        quotaTotalTokens: 1_000_000,
        quotaSafetyRatio: 0.95,
        quotaBlocked: false,
      })}
    />);
    expect(screen.getByText("1,200,000 / 1,000,000")).toBeTruthy();
    const progress = screen.getByRole("progressbar", { name: "超额模型额度 100%" });
    const now = Number(progress.getAttribute("aria-valuenow"));
    const max = Number(progress.getAttribute("aria-valuemax"));
    expect(now).toBe(1_000_000);
    expect(max).toBe(1_000_000);
    expect(now).toBeLessThanOrEqual(max);
  });

  it("renders unlimited and invalid states without a progressbar", () => {
    const { rerender } = render(<QuotaMeter
      modelName="不限额模型"
      quota={quotaPresentation({
        quotaUsedTokens: 10,
        quotaTotalTokens: null,
        quotaSafetyRatio: 0.95,
        quotaBlocked: false,
      })}
    />);
    expect(screen.getByText("不限额")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();

    rerender(<QuotaMeter
      modelName="异常模型"
      quota={quotaPresentation({
        quotaUsedTokens: 10,
        quotaTotalTokens: 0,
        quotaSafetyRatio: 0.95,
        quotaBlocked: false,
      })}
    />);
    expect(screen.getByText("额度数据异常")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npx vitest run src/client/components/model-config/QuotaMeter.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the quota meter**

Create `QuotaMeter.tsx`:

```tsx
import { formatQuotaTokens, type QuotaPresentation } from "./quota-presentation";

export function QuotaMeter({
  modelName,
  quota,
}: {
  modelName: string;
  quota: QuotaPresentation;
}) {
  if (quota.kind !== "finite" || quota.total == null) {
    return (
      <div className={`quota-meter ${quota.tone}`} data-quota-state={quota.tone}>
        <span className="quota-meter-value">
          {formatQuotaTokens(quota.used)} / {quota.statusText}
        </span>
        <span className="quota-meter-status">{quota.statusText}</span>
      </div>
    );
  }
  return (
    <div className={`quota-meter ${quota.tone}`} data-quota-state={quota.tone}>
      <span className="quota-meter-value">
        {formatQuotaTokens(quota.used)} / {formatQuotaTokens(quota.total)}
      </span>
      <span
        className="quota-meter-track"
        role="progressbar"
        aria-label={`${modelName}额度 ${quota.percent}%`}
        aria-valuemin={0}
        aria-valuemax={quota.total}
        aria-valuenow={quota.progressValue}
      >
        <span className="quota-meter-fill" style={{ width: `${quota.percent}%` }} />
      </span>
      <span className="quota-meter-status">{quota.statusText}</span>
    </div>
  );
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```powershell
npx vitest run src/client/components/model-config/QuotaMeter.test.tsx
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/client/components/model-config/QuotaMeter.tsx src/client/components/model-config/QuotaMeter.test.tsx
git commit -m "feat: add accessible model quota meter"
```

---

### Task 4: Integrate Selection, Identity, and Quota UI

**Files:**
- Modify: `src/client/components/model-config/PoolView.tsx`
- Modify: `src/client/components/ModelConfigDialog.test.tsx`
- Modify: `src/client/styles.css`

**Interfaces:**
- Consumes: `PoolCheckbox`
- Consumes: `QuotaMeter`
- Consumes: `quotaPresentation`
- Preserves all existing request bodies and model-pool operations.

- [ ] **Step 1: Add failing integration tests**

Append focused tests to `ModelConfigDialog.test.tsx`:

```tsx
it("shows native half-selection and selected row state", async () => {
  const first = member({ id: "first", name: "模型甲" });
  const second = member({ id: "second", name: "模型乙" });
  await renderDialog([first, second]);

  const selectAll = await screen.findByRole("checkbox", { name: "全选当前用途成员" });
  expect((selectAll as HTMLInputElement).indeterminate).toBe(false);

  fireEvent.click(screen.getByRole("checkbox", { name: "选择成员 模型甲" }));
  expect((selectAll as HTMLInputElement).indeterminate).toBe(true);
  expect(screen.getByText("模型甲").closest("tr")?.classList.contains("selected")).toBe(true);

  fireEvent.click(screen.getByRole("checkbox", { name: "选择成员 模型乙" }));
  expect((selectAll as HTMLInputElement).indeterminate).toBe(false);
  expect((selectAll as HTMLInputElement).checked).toBe(true);
});

it("renders quota progress and safe edge states without changing bulk actions", async () => {
  const quotaMembers = [
    member({ id: "normal", name: "正常额度", quotaUsedTokens: 800, quotaTotalTokens: 1000 }),
    member({ id: "warning", name: "接近阈值", quotaUsedTokens: 950, quotaTotalTokens: 1000 }),
    member({ id: "unlimited", name: "不限额", quotaUsedTokens: 10, quotaTotalTokens: undefined }),
    member({ id: "invalid", name: "异常额度", quotaUsedTokens: 10, quotaTotalTokens: 0 }),
  ];
  await renderDialog(quotaMembers);

  expect(screen.getByRole("progressbar", { name: "正常额度额度 80%" })).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "接近阈值额度 95%" })
    .closest(".quota-meter")?.getAttribute("data-quota-state")).toBe("warning");
  expect(screen.getByText("不限额")).toBeTruthy();
  expect(screen.getByText("额度数据异常")).toBeTruthy();

  fireEvent.click(screen.getByRole("checkbox", { name: "选择成员 正常额度" }));
  expect(screen.getByRole("button", { name: "验证已选" })).not.toBeDisabled();
});
```

Update `renderDialog` response data so custom model arrays are also returned from `/api/model-pools`; use a local `currentMembers` fixture rather than returning the global `members` constant.

- [ ] **Step 2: Run integration tests and verify RED**

Run:

```powershell
npx vitest run src/client/components/ModelConfigDialog.test.tsx
```

Expected: new tests FAIL because there is no half-selection property, selected row class, or quota meter.

- [ ] **Step 3: Integrate the components**

In `PoolView.tsx`:

```ts
import { PoolCheckbox } from "./PoolCheckbox";
import { QuotaMeter } from "./QuotaMeter";
import { formatQuotaTokens, quotaPresentation } from "./quota-presentation";
```

Replace selection calculations with:

```ts
const visibleSelectedCount = members.filter((model) => selectedIds.includes(model.id)).length;
const visibleSelected = members.length > 0 && visibleSelectedCount === members.length;
const visiblePartiallySelected = visibleSelectedCount > 0 && visibleSelectedCount < members.length;
```

Replace the header checkbox:

```tsx
<PoolCheckbox
  label="全选当前用途成员"
  checked={visibleSelected}
  indeterminate={visiblePartiallySelected}
  disabled={!members.length}
  onChange={toggleVisible}
/>
```

For each row:

```tsx
const quota = quotaPresentation(model);
const selected = selectedIds.includes(model.id);
return (
  <tr key={model.id} className={selected ? "selected" : undefined}>
    <td>
      <PoolCheckbox
        label={`选择成员 ${model.name}`}
        checked={selected}
        onChange={() => toggleSelected(model.id)}
      />
    </td>
```

Keep the existing edit inputs. In display mode replace the `已用/总额` text with:

```tsx
<QuotaMeter modelName={model.name} quota={quota} />
```

Render the remaining column with:

```tsx
{quota.remaining == null ? "—" : formatQuotaTokens(quota.remaining)}
```

The model identity cell remains display name, model ID, and provider, but add title attributes to truncated values.

- [ ] **Step 4: Add scoped CSS**

In the existing model console section of `styles.css`, add:

```css
.pool-checkbox{
  appearance:none;
  display:inline-grid;
  place-content:center;
  width:16px;
  height:16px;
  margin:0;
  border:1px solid #81948a;
  border-radius:0;
  background:#fff;
  color:var(--pixel-ink);
  vertical-align:middle;
}
.pool-checkbox::before{
  content:"";
  width:8px;
  height:8px;
  transform:scale(0);
  background:var(--pixel-ink);
}
.pool-checkbox:checked,.pool-checkbox:indeterminate{
  border-color:#789f43;
  background:var(--pixel-green);
}
.pool-checkbox:checked::before{transform:scale(1);clip-path:polygon(14% 44%,0 59%,39% 100%,100% 19%,84% 4%,38% 70%)}
.pool-checkbox:indeterminate::before{transform:scale(1);height:2px}
.pool-checkbox:focus-visible{outline:2px solid var(--pixel-orange);outline-offset:2px}
.pool-checkbox:disabled{cursor:not-allowed;opacity:.45}
.model-pool-table tbody tr.selected{background:#eef6e5}
.model-pool-table tbody tr.selected:hover{background:#e7f2dc}
.model-name-cell strong{
  display:-webkit-box;
  min-height:2.8em;
  overflow:hidden;
  -webkit-box-orient:vertical;
  -webkit-line-clamp:2;
  line-clamp:2;
  font-size:11px;
  line-height:1.4;
}
.model-name-cell code,.model-name-cell small{
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.quota-meter{display:grid;gap:4px;min-width:130px}
.quota-meter-value{font:9px "Cascadia Mono","Consolas",monospace;white-space:nowrap}
.quota-meter-track{display:block;height:8px;border:1px solid currentColor;background:#edf0ee;overflow:hidden}
.quota-meter-fill{display:block;height:100%;background:currentColor}
.quota-meter-status{font-size:8px;font-weight:700}
.quota-meter.normal{color:#547638}
.quota-meter.warning{color:#946027}
.quota-meter.exhausted{color:#9d543f}
.quota-meter.unlimited{color:#3b7067}
.quota-meter.invalid{color:#707d76}
```

Increase the model identity and quota columns while keeping the table horizontally scrollable:

```css
.model-pool-table{min-width:1420px}
.model-pool-table th:nth-child(2){width:220px}
.model-pool-table th:nth-child(5){width:180px}
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npx vitest run `
  src/client/components/model-config/quota-presentation.test.ts `
  src/client/components/model-config/PoolCheckbox.test.tsx `
  src/client/components/model-config/QuotaMeter.test.tsx `
  src/client/components/ModelConfigDialog.test.tsx
```

Expected: all focused tests PASS.

- [ ] **Step 6: Run interaction regression tests**

Run:

```powershell
npx vitest run src/client/App.test.tsx src/client/auth/capability-gating.test.tsx
```

Expected: all tests PASS; model management permissions and top-level dialog behavior remain unchanged.

- [ ] **Step 7: Commit**

```powershell
git add src/client/components/model-config/PoolView.tsx src/client/components/ModelConfigDialog.test.tsx src/client/styles.css
git commit -m "feat: refine model pool selection and quota display"
```

---

### Task 5: Ticket State and Complete Verification

**Files:**
- Modify: `.scratch/model-pool-optimization/issues/02-model-pool-console-ui.md`

**Interfaces:**
- Ticket result: `in-review`, with implementation/test criteria checked and screenshot/multi-resolution criteria left unchecked.

- [ ] **Step 1: Update ticket status**

Set:

```markdown
**Status:** in-review (2026-09-20) — 模型身份层级、自定义原生复选框、半选状态、额度进度条、异常额度保护和自动化回归已完成；真实局域网四尺寸与截图归档待验收
```

Check:

- identity hierarchy and stable two-line name implementation;
- checkbox selection/half-selection/keyboard semantics;
- progress and exact values;
- normal/warning/exhausted/unlimited states;
- null/zero/overage/invalid data protection;
- existing operations regression;
- component tests;
- typecheck/build/test after they pass.

Leave the four real viewport and screenshot criteria unchecked.

- [ ] **Step 2: Run complete verification**

Run:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
```

Expected:

- all tests PASS;
- typecheck and build exit `0`;
- lint has no errors;
- no whitespace errors.

- [ ] **Step 3: Commit**

```powershell
git add .scratch/model-pool-optimization/issues/02-model-pool-console-ui.md
git commit -m "docs: move model pool console UI to acceptance"
```

