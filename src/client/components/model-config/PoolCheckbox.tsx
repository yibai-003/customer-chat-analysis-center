import { useLayoutEffect, useRef } from "react";

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

  function syncIndeterminate() {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }

  useLayoutEffect(syncIndeterminate);

  function handleChange() {
    syncIndeterminate();
    onChange();
  }

  return (
    <input
      ref={ref}
      className="pool-checkbox"
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={handleChange}
    />
  );
}
