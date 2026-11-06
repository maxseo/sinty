import { useEffect, useState } from "preact/hooks";

export function CSelect({
  value,
  onChange,
  options,
  emptyLabel,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; sub?: string }[];
  emptyLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    const timer = window.setTimeout(() => document.addEventListener("click", close), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("click", close);
    };
  }, [open]);
  const current = options.find((o) => o.value === value);
  const shown = current?.label || (value ? value : (emptyLabel || "-"));
  return (
    <div class={open ? "cselect open" : "cselect"} onClick={(e) => e.stopPropagation()}>
      <button type="button" class="cselect-btn" aria-haspopup="listbox" disabled={disabled} onClick={() => setOpen((v) => !v)}>
        <span class="cselect-val">{shown}</span>
        <svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4.2 6.2 8 10l3.8-3.8 1.2 1.2L8 12.4 3 7.4z"/></svg>
      </button>
      {open && (
        <div class="cselect-menu" role="listbox">
          {emptyLabel !== undefined && (
            <button type="button" class={!value ? "cselect-opt on" : "cselect-opt"} onClick={() => { onChange(""); setOpen(false); }}>{emptyLabel}</button>
          )}
          {options.map((o) => (
            <button key={o.value} type="button" class={o.value === value ? "cselect-opt on" : "cselect-opt"} onClick={() => { onChange(o.value); setOpen(false); }}>
              {o.label}
              {o.sub && <span class="sub">{o.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Tog({ on, onClick, disabled, label }: { on: boolean; onClick: () => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" class={on ? "tog on" : "tog"} aria-pressed={on} aria-label={label} disabled={disabled} onClick={onClick} />
  );
}
