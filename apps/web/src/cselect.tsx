import { createPortal } from "preact/compat";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";

/** Shared select: a body portal escapes clipping/stacking contexts without changing card overflow. */
interface SelectProps {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; sub?: string }[];
  emptyLabel?: string;
  disabled?: boolean;
  label?: string;
  searchable?: boolean;
}

export function CSelect(props: SelectProps) { return <SelectControl {...props} />; }
export function CMultiSelect({ values, onChange, ...props }: Omit<SelectProps, "value" | "onChange" | "emptyLabel"> & { values: string[]; onChange: (values: string[]) => void }) {
  return <SelectControl {...props} value="" onChange={() => undefined} multipleValues={values} onValuesChange={onChange} />;
}

function SelectControl({ value, onChange, options, emptyLabel, disabled, label, searchable, multipleValues, onValuesChange }: SelectProps & { multipleValues?: string[]; onValuesChange?: (values: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const [search, setSearch] = useState("");
  const multiple = multipleValues !== undefined;
  const menu = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const id = useId();
  const allItems = emptyLabel === undefined ? options : [{ value: "", label: emptyLabel }, ...options.filter(o => o.value !== "")];
  const items = allItems.filter(o => !search || (o.label + " " + (o.sub ?? "")).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const selected = items.findIndex(o => o.value === value);
  const shown = allItems.find(o => o.value === value)?.label || value || emptyLabel || "—";
  const close = (restore = false): void => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  const show = (index = Math.max(0, selected)): void => { if (!disabled) { setActive(index); setOpen(true); } };
  const choose = (index: number): void => {
    const item = items[index];
    if (multiple) { if (item) onValuesChange?.(multipleValues!.includes(item.value) ? multipleValues!.filter(v => v !== item.value) : [...multipleValues!, item.value]); }
    else { if (item) onChange(item.value); close(true); }
  };

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => { if (!open) { setSearch(""); typed.current = { text: "", at: 0 }; } }, [open]);
  useLayoutEffect(() => { if (open && searchable) menu.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true }); }, [open, searchable]);
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const position = (): void => {
      frame = 0;
      const button = trigger.current, popup = menu.current;
      if (!button || !popup) return;
      const r = button.getBoundingClientRect(), vv = window.visualViewport;
      const x = vv?.offsetLeft ?? 0, y = vv?.offsetTop ?? 0;
      const w = vv?.width ?? document.documentElement.clientWidth, h = vv?.height ?? window.innerHeight;
      if (r.bottom <= y || r.top >= y + h || r.right <= x || r.left >= x + w) { setOpen(false); return; }
      // A trigger scrolled out of a clipped ancestor must not leave a floating orphan menu.
      for (let p = button.parentElement; p && p !== document.body; p = p.parentElement) {
        const css = getComputedStyle(p), box = p.getBoundingClientRect();
        if ((/(auto|scroll|hidden|clip)/.test(css.overflowY) && (r.bottom <= box.top || r.top >= box.bottom))
          || (/(auto|scroll|hidden|clip)/.test(css.overflowX) && (r.right <= box.left || r.left >= box.right))) { setOpen(false); return; }
      }
      const margin = 8, gap = 6;
      const below = Math.max(0, y + h - margin - r.bottom - gap);
      const above = Math.max(0, r.top - y - margin - gap);
      const desired = Math.min(240, popup.scrollHeight + 2);
      const up = below < desired && above > below;
      const height = Math.min(desired, up ? above : below);
      const width = Math.min(Math.max(120, r.width), Math.max(0, w - margin * 2));
      const left = Math.max(x + margin, Math.min(r.left, x + w - margin - width));
      Object.assign(popup.style, { left: left + "px", top: (up ? r.top - gap - height : r.bottom + gap) + "px", width: width + "px", maxHeight: height + "px", visibility: "visible" });
      popup.dataset.placement = up ? "top" : "bottom";
    };
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(position); };
    const onScroll = (event: Event): void => { if (!menu.current?.contains(event.target as Node)) schedule(); };
    const outside = (event: Event): void => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    position();
    const observer = new ResizeObserver(schedule);
    if (trigger.current) observer.observe(trigger.current);
    if (menu.current) observer.observe(menu.current);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [open, items.length]);
  useLayoutEffect(() => {
    if (!open) return;
    const popup = menu.current, option = popup?.querySelectorAll<HTMLElement>('[role="option"]')[active];
    if (!popup || !option) return;
    if (option.offsetTop < popup.scrollTop) popup.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > popup.scrollTop + popup.clientHeight) popup.scrollTop = option.offsetTop + option.offsetHeight - popup.clientHeight;
  }, [open, active]);
  const key = (e: KeyboardEvent): void => {
    if (disabled) return;
    if (e.key === "Escape") { if (open) { e.preventDefault(); e.stopPropagation(); close(true); } return; }
    if (e.key === "Tab") { if (menu.current?.contains(e.target as Node)) trigger.current?.focus({ preventScroll: true }); close(); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const last = Math.max(0, items.length - 1);
      const index = e.key === "Home" ? 0 : e.key === "End" ? last : !open ? Math.max(0, selected)
        : (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length);
      show(index); return;
    }
    if (e.key === "Enter" || (e.key === " " && !(e.target instanceof HTMLInputElement))) { e.preventDefault(); if (open) choose(active); else show(); return; }
    if (searchable && !(e.target instanceof HTMLInputElement) && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); setSearch(e.key); setActive(0); setOpen(true); return;
    }
    if (!(e.target instanceof HTMLInputElement) && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + e.key.toLocaleLowerCase(), at: now };
      const index = items.findIndex(o => o.label.toLocaleLowerCase().startsWith(typed.current.text));
      if (index >= 0) { e.preventDefault(); show(index); }
    }
  };
  const triggerProps = {
    id: id + "-trigger", role: "combobox" as const, class: "cselect-btn", "aria-label": label,
    "aria-haspopup": "listbox" as const, "aria-expanded": open,
    "aria-controls": open ? id + "-list" : undefined,
    "aria-activedescendant": open && items[active] ? id + "-opt-" + active : undefined,
    onKeyDown: key, onClick: () => { if (!disabled) { if (open) close(); else show(); } },
  };
  const content = <>
    <span class={multiple ? "cselect-val multi-val" : "cselect-val"}>
      {multiple ? multipleValues!.length ? multipleValues!.map(v => <span key={v} class="cselect-chip">
        {options.find(o => o.value === v)?.label ?? v}
        <button type="button" class="cselect-chip-remove" aria-label={"Убрать " + (options.find(o => o.value === v)?.label ?? v)} disabled={disabled}
          onKeyDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onValuesChange?.(multipleValues!.filter(x => x !== v)); trigger.current?.focus({ preventScroll: true }); }}>×</button>
      </span>) : "Ничего не выбрано" : shown}
    </span>
    <svg class="chev" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4.2 6.2 8 10l3.8-3.8 1.2 1.2L8 12.4 3 7.4z"/></svg>
  </>;
  return (
    <div ref={root} class={open ? "cselect open" : "cselect"} onClick={e => e.stopPropagation()}>
      {multiple ? <div ref={el => { trigger.current = el; }} {...triggerProps} tabIndex={disabled ? -1 : 0} aria-disabled={disabled}>{content}</div>
        : <button ref={el => { trigger.current = el; }} type="button" {...triggerProps} disabled={disabled}>{content}</button>}
      {open && createPortal(
        <div ref={menu} class="cselect-menu" style={{ visibility: "hidden" }} onClick={e => e.stopPropagation()}>
          {searchable && <input class="cselect-search" type="search" aria-label={"Поиск: " + (label ?? "варианты")} placeholder="Найти" autoComplete="off" value={search}
            aria-controls={id + "-list"} aria-activedescendant={items[active] ? id + "-opt-" + active : undefined}
            onInput={e => { setSearch(e.currentTarget.value); setActive(0); }} onKeyDown={key} />}
          <div id={id + "-list"} class="cselect-options" role="listbox" aria-labelledby={id + "-trigger"} aria-multiselectable={multiple || undefined}>
            {items.map((o, i) => { const chosen = multiple ? multipleValues!.includes(o.value) : o.value === value;
              return <div key={o.value} id={id + "-opt-" + i} role="option" aria-selected={chosen}
                class={"cselect-opt" + (chosen ? " on" : "") + (i === active ? " active" : "")}
                onPointerDown={e => e.preventDefault()} onPointerMove={() => setActive(i)} onClick={() => choose(i)}>
                {o.label}{o.sub && <span class="sub">{o.sub}</span>}
              </div>;
            })}
            {!items.length && <div class="cselect-empty">{search ? "Ничего не найдено" : "Нет вариантов"}</div>}
          </div>
        </div>, document.body)}
    </div>
  );
}

export function Tog({ on, onClick, disabled, label }: { on: boolean; onClick: () => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" class={on ? "tog on" : "tog"} aria-pressed={on} aria-label={label} disabled={disabled} onClick={onClick} />
  );
}
