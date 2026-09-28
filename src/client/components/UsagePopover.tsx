import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { JobUsageSummary } from "../../shared/types";

interface UsagePopoverProps {
  ariaLabel: string;
  summary: JobUsageSummary;
  compactLabel: string;
  className?: string;
}

const numberFormatter = new Intl.NumberFormat("zh-CN");

export function UsagePopover({
  ariaLabel,
  summary,
  compactLabel,
  className = "",
}: UsagePopoverProps) {
  const popupId = useId().replaceAll(":", "");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});

  const cancelClose = () => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const updatePosition = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = 236;
    const gap = 8;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const fitsBelow = rect.bottom + gap + 188 <= window.innerHeight;
    setPosition({
      left,
      top: fitsBelow ? rect.bottom + gap : undefined,
      bottom: fitsBelow ? undefined : window.innerHeight - rect.top + gap,
      width,
    });
  };

  const show = () => {
    cancelClose();
    updatePosition();
    setOpen(true);
  };

  const hide = () => {
    cancelClose();
    setPinned(false);
    setOpen(false);
  };

  const scheduleClose = () => {
    if (pinned) return;
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 100);
  };

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (pinned) {
      hide();
    } else {
      cancelClose();
      updatePosition();
      setPinned(true);
      setOpen(true);
    }
  };

  useEffect(() => {
    if (!open) return;
    const reposition = () => updatePosition();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        hide();
        triggerRef.current?.focus();
      }
    };
    const closeOnOutsideClick = (event: globalThis.MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      hide();
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("mousedown", closeOnOutsideClick);
    };
  }, [open]);

  useEffect(() => () => cancelClose(), []);

  const detailRows = [
    ["输入 Token", summary.inputTokens],
    ["输出 Token", summary.outputTokens],
    ["计费 Token", summary.accountedTokens],
    ["调用次数", summary.callCount],
  ] as const;

  return <>
    <button
      ref={triggerRef}
      type="button"
      className={`usage-popover-trigger${className ? ` ${className}` : ""}`}
      aria-label={ariaLabel}
      aria-expanded={open}
      aria-describedby={open ? popupId : undefined}
      onClick={toggle}
      onMouseEnter={show}
      onMouseLeave={scheduleClose}
      onFocus={show}
      onBlur={() => {
        if (!pinned) hide();
      }}
    >
      <span>{compactLabel}</span>
      <i aria-hidden="true">i</i>
    </button>
    {open && createPortal(
      <div
        ref={panelRef}
        id={popupId}
        className="usage-popover-panel"
        role="tooltip"
        style={position}
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
      >
        <div className="usage-popover-head">
          <strong>模型用量明细</strong>
          <span>当前累计</span>
        </div>
        <dl>
          {detailRows.map(([label, value]) => <div key={label}>
            <dt>{label}</dt>
            <dd>{numberFormatter.format(value)}</dd>
          </div>)}
          <div className={summary.unknownCallCount ? "warning" : ""}>
            <dt>未知用量</dt>
            <dd>{numberFormatter.format(summary.unknownCallCount)} 次</dd>
          </div>
        </dl>
      </div>,
      document.body,
    )}
  </>;
}
