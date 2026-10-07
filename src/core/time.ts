// Timestamps are stored as UTC ISO strings ("2026-09-30T14:38:00.000Z") so
// SQL string comparison orders them correctly. Inputs may be:
//   - an ISO datetime with offset or Z  → taken as-is
//   - an ISO datetime without offset    → wall-clock time in the ledger timezone
//   - a bare date (YYYY-MM-DD)          → noon in the ledger timezone; for
//     today, "now" (so "I spent this today" is never in the future)

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

export interface Instant {
  iso: string;
  dateOnly: boolean;
}

export function toInstant(input: string, tz: string, now?: string): Instant {
  const s = input.trim();
  if (DATE_ONLY.test(s)) {
    if (now && localDate(now, tz) === s) return { iso: now, dateOnly: true };
    const [y, m, d] = s.split("-").map(Number);
    return { iso: new Date(localToUtc(y, m, d, 12, 0, 0, tz)).toISOString(), dateOnly: true };
  }
  const naive = NAIVE.exec(s);
  if (naive) {
    const [, y, m, d, h, mi, sec] = naive;
    return {
      iso: new Date(localToUtc(+y, +m, +d, +h, +mi, +(sec ?? 0), tz)).toISOString(),
      dateOnly: false,
    };
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new LedgerError(`Unreadable date/time: "${input}"`);
  return { iso: new Date(t).toISOString(), dateOnly: false };
}

/** YYYY-MM-DD of an instant in the ledger timezone. */
export function localDate(iso: string, tz: string): string {
  const p = parts(Date.parse(iso), tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** YYYY-MM of an instant in the ledger timezone. */
export function localMonth(iso: string, tz: string): string {
  return localDate(iso, tz).slice(0, 7);
}

/** UTC ISO bounds [start, end) of a local month. */
export function monthBounds(ym: string, tz: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  const start = localToUtc(y, m, 1, 0, 0, 0, tz);
  const end = m === 12 ? localToUtc(y + 1, 1, 1, 0, 0, 0, tz) : localToUtc(y, m + 1, 1, 0, 0, 0, tz);
  return [new Date(start).toISOString(), new Date(end).toISOString()];
}

/** UTC ISO bounds [start, end) of local dates, end inclusive. */
export function dateRangeBounds(from: string, to: string, tz: string): [string, string] {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  const end = localToUtc(y2, m2, d2, 0, 0, 0, tz) + 86_400_000;
  return [new Date(localToUtc(y1, m1, d1, 0, 0, 0, tz)).toISOString(), new Date(end).toISOString()];
}

export function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(toDate + "T00:00:00Z") - Date.parse(fromDate + "T00:00:00Z")) / 86_400_000);
}

function localToUtc(y: number, m: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const off = offsetMinutes(guess, tz);
  let t = guess - off * 60_000;
  const off2 = offsetMinutes(t, tz);
  if (off2 !== off) t = guess - off2 * 60_000;
  return t;
}

function offsetMinutes(utcMs: number, tz: string): number {
  const p = parts(utcMs, tz);
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs) / 60_000;
}

function parts(utcMs: number, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const all = fmt.formatToParts(new Date(utcMs));
  const get = (t: string) => Number(all.find((x) => x.type === t)!.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** An error whose message is safe and useful to show to the caller. */
export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}
