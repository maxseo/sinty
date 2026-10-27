import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "./api.js";

interface Item {
  jobId: string;
  name: string;
  at: string;
  kind: string;
}

function firesLabel(n: number): string {
  const n10 = n % 10;
  const n100 = n % 100;
  const word = n10 === 1 && n100 !== 11 ? "срабатывание" : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? "срабатывания" : "срабатываний";
  return `${n} ${word} в этом месяце`;
}

const DOW = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];

export function CalendarPage() {
  const [cursor, setCursor] = useState(() => new Date());
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState("");
  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  useEffect(() => {
    let live = true;
    const from = new Date(year, month, 1);
    const to = new Date(year, month + 1, 0, 23, 59, 59);
    void api<{ items: Item[] }>(`/p/scheduler/occurrences?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)
      .then((r) => { if (live) { setItems(r.items); setError(""); } })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [year, month]);

  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    const lead = (first.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - lead);
    const today = new Date();
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const slots = items.filter((item) => {
        const t = new Date(item.at);
        return t.getFullYear() === d.getFullYear() && t.getMonth() === d.getMonth() && t.getDate() === d.getDate();
      });
      return {
        key,
        day: d.getDate(),
        out: d.getMonth() !== month,
        today: d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate(),
        slots,
      };
    });
  }, [year, month, items]);

  return (
    <section class="cal-page">
      <header class="cal-top">
        <div>
          <h2>Календарь</h2>
          <p>{firesLabel(items.length)}</p>
        </div>
        <button type="button" class="cal-ghost" onClick={() => setCursor(new Date())}>Сегодня</button>
      </header>
      <div class="month-bar">
        <div class="month-nav">
          <button type="button" aria-label="Предыдущий месяц" onClick={() => setCursor(new Date(year, month - 1, 1))}>‹</button>
          <button type="button" aria-label="Следующий месяц" onClick={() => setCursor(new Date(year, month + 1, 1))}>›</button>
        </div>
        <h3 class="month-title">{MONTHS[month]} {year}</h3>
      </div>
      {error && <p class="error">{error}</p>}
      <div class="cal-wrap">
        <div class="cal">
          {DOW.map((d) => <div key={d} class="cal-dow">{d}</div>)}
          {cells.map((cell) => (
            <div key={cell.key} class={`cell ${cell.out ? "is-out" : ""} ${cell.today ? "is-today" : ""}`}>
              <span class="cell__num">{cell.day}</span>
              <div class="cell__list">
                {cell.slots.slice(0, 4).map((slot) => {
                  const t = new Date(slot.at);
                  const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
                  return (
                    <div key={`${slot.jobId}-${slot.at}`} class="slot" title={slot.name}>
                      <span class="slot__time">{hm}</span>
                      <span class="slot__title">{slot.name}</span>
                    </div>
                  );
                })}
                {cell.slots.length > 4 && <span class="slot__more">+{cell.slots.length - 4}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
