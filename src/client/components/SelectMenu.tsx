import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

export interface SelectMenuOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectMenuProps {
  ariaLabel: string;
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  align?: "start" | "end";
  className?: string;
}

function scheduleFocus(callback: () => void) {
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(callback);
    return;
  }
  window.setTimeout(callback, 0);
}

export function SelectMenu({
  ariaLabel,
  value,
  options,
  onChange,
  disabled = false,
  align = "start",
  className = "",
}: SelectMenuProps) {
  const id = useId().replaceAll(":", "");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selectedOption = options[selectedIndex] ?? options[0];

  const enabledIndexes = options.reduce<number[]>((indexes, option, index) => {
    if (!option.disabled) indexes.push(index);
    return indexes;
  }, []);

  const focusOption = (index: number) => {
    setActiveIndex(index);
    scheduleFocus(() => optionRefs.current[index]?.focus());
  };

  const openMenu = (index = selectedIndex) => {
    if (disabled || !enabledIndexes.length) return;
    const nextIndex = options[index]?.disabled ? enabledIndexes[0] : index;
    setOpen(true);
    focusOption(nextIndex);
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    setActiveIndex(selectedIndex);
    if (restoreFocus) scheduleFocus(() => triggerRef.current?.focus());
  };

  const moveOption = (direction: 1 | -1) => {
    if (!enabledIndexes.length) return;
    const currentPosition = enabledIndexes.indexOf(activeIndex);
    const fallbackPosition = direction > 0 ? -1 : 0;
    const nextPosition = (currentPosition + direction + enabledIndexes.length
      + (currentPosition < 0 ? fallbackPosition : 0)) % enabledIndexes.length;
    focusOption(enabledIndexes[nextPosition]);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    closeMenu(true);
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openMenu(event.key === "ArrowDown" ? selectedIndex : enabledIndexes.at(-1));
    } else if (event.key === "Home") {
      event.preventDefault();
      openMenu(enabledIndexes[0]);
    } else if (event.key === "End") {
      event.preventDefault();
      openMenu(enabledIndexes.at(-1));
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      closeMenu();
    }
  };

  const handleOptionKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveOption(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusOption(enabledIndexes[0]);
    } else if (event.key === "End") {
      event.preventDefault();
      focusOption(enabledIndexes.at(-1) ?? index);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === "Tab") {
      closeMenu();
    }
  };

  useEffect(() => {
    setActiveIndex(selectedIndex);
  }, [selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setActiveIndex(selectedIndex);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open, selectedIndex]);

  return <div
    ref={rootRef}
    className={`select-menu${className ? ` ${className}` : ""}`}
    data-align={align}
    data-open={open ? "true" : "false"}
  >
    <button
      ref={triggerRef}
      type="button"
      className="select-menu-trigger"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={`${id}-listbox`}
      value={value}
      disabled={disabled}
      onClick={() => open ? closeMenu() : openMenu()}
      onKeyDown={handleTriggerKeyDown}
    >
      <span>{selectedOption?.label ?? ""}</span>
      <i className="select-menu-caret" aria-hidden="true" />
    </button>
    {open && <div
      id={`${id}-listbox`}
      className="select-menu-popup"
      role="listbox"
      aria-label={`${ariaLabel}选项`}
    >
      {options.map((option, index) => <button
        key={option.value}
        ref={(element) => { optionRefs.current[index] = element; }}
        type="button"
        className="select-menu-option"
        role="option"
        aria-selected={option.value === value}
        data-value={option.value}
        disabled={option.disabled}
        tabIndex={index === activeIndex ? 0 : -1}
        onClick={() => choose(index)}
        onKeyDown={(event) => handleOptionKeyDown(event, index)}
      >
        <span>{option.label}</span>
        <i aria-hidden="true" />
      </button>)}
    </div>}
  </div>;
}
