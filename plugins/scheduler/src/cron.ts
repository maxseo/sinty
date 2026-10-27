/**
 * Minimal 5-field cron (minute hour dom month dow). Supports star, N, ranges, steps, and comma lists.
 * Fields: minute 0-59, hour 0-23, day-of-month 1-31, month 1-12, day-of-week 0-6 (Sun=0).
 * Dow 7 is accepted as Sunday. No aliases, no seconds, no timezone - wall clock local.
 */
export type CronFields = { minute: number[]; hour: number[]; dom: number[]; month: number[]; dow: number[] };

function parseField(raw: string, min: number, max: number): number[] {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const stepMatch = /^([^/]+)\/(\d+)$/.exec(part);
    const range = stepMatch ? stepMatch[1]! : part;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step in "${raw}"`);
    let start: number;
    let end: number;
    if (range === "*") {
      start = min;
      end = max;
    } else if (/^\d+$/.test(range)) {
      start = end = Number(range);
    } else {
      const m = /^(\d+)-(\d+)$/.exec(range);
      if (!m) throw new Error(`bad cron field "${raw}"`);
      start = Number(m[1]);
      end = Number(m[2]);
    }
    if (start < min || end > max || start > end) throw new Error(`cron field out of range in "${raw}" (${min}-${max})`);
    for (let n = start; n <= end; n += step) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron must have 5 fields: minute hour dom month dow");
  const dow = parseField(parts[4]!, 0, 7).map((d) => (d === 7 ? 0 : d));
  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dom: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12),
    dow: [...new Set(dow)].sort((a, b) => a - b),
  };
}

function matches(fields: CronFields, d: Date): boolean {
  return (
    fields.minute.includes(d.getMinutes()) &&
    fields.hour.includes(d.getHours()) &&
    fields.dom.includes(d.getDate()) &&
    fields.month.includes(d.getMonth() + 1) &&
    fields.dow.includes(d.getDay())
  );
}

/** Fires in [from, to], at most `limit` hits. A every-minute cron stops at the cap. */
export function cronBetween(expr: string, from: Date, to: Date, limit = 48): Date[] {
  const out: Date[] = [];
  let cursor = new Date(from.getTime() - 60_000);
  while (out.length < limit) {
    const next = nextCronAfter(expr, cursor);
    if (next.getTime() > to.getTime()) break;
    if (next.getTime() >= from.getTime()) out.push(next);
    cursor = next;
  }
  return out;
}

/** Next fire strictly after `from` (ms), searching minute by minute up to ~1 year. */
export function nextCronAfter(expr: string, from: Date = new Date()): Date {
  const fields = parseCron(expr);
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = cursor.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() < limit) {
    if (matches(fields, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error(`no next fire for cron "${expr}" within a year`);
}

export function cronDue(expr: string, lastRunAt: string | null, now: Date): boolean {
  const fields = parseCron(expr);
  if (!matches(fields, now)) return false;
  if (!lastRunAt) return true;
  const last = new Date(lastRunAt);
  // Same local minute slot already fired.
  return !(
    last.getFullYear() === now.getFullYear() &&
    last.getMonth() === now.getMonth() &&
    last.getDate() === now.getDate() &&
    last.getHours() === now.getHours() &&
    last.getMinutes() === now.getMinutes()
  );
}
