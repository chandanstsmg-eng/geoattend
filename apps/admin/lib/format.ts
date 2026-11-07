/**
 * Times and "today" are shown in the business time zone, not the zone of whoever opens the page, so
 * an owner travelling abroad sees the same day and the same clock times as the site. Screens that know
 * a workplace's own zone pass it as `tz`.
 */
export const BUSINESS_ZONE = 'Asia/Kolkata';

export function fmtDateTime(v: string | Date | null | undefined, tz: string = BUSINESS_ZONE) {
  if (!v) return '—';
  return new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz });
}

export function fmtTime(v: string | Date | null | undefined, tz: string = BUSINESS_ZONE) {
  if (!v) return '—';
  return new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: tz });
}

/** Hours and minutes only, for dense tables (the full time stays in the record view). */
export function fmtClock(v: string | Date | null | undefined, tz: string = BUSINESS_ZONE) {
  if (!v) return '—';
  return new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: tz });
}

/** "Friday, 31 October 2026" for page subtitles. */
export function fmtLongDate(v: string | null | undefined) {
  if (!v) return '—';
  return new Date(`${v.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function fmtDate(v: string | null | undefined) {
  if (!v) return '—';
  // A plain date has no zone to convert: it is shown as it is. Only timestamps move to the business zone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T12:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });
  return new Date(v).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: BUSINESS_ZONE });
}

export function ago(v: string | Date | null | undefined, now = Date.now()) {
  if (!v) return 'never';
  const s = Math.max(0, Math.round((now - new Date(v).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export function minutes(m: number | null | undefined) {
  if (m === null || m === undefined) return '—';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const metres = (m: number | null | undefined) => (m === null || m === undefined ? '—' : `${Math.round(m)} m`);

/** YYYY-MM-DD of an instant in the business zone. */
export const businessDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export const todayISO = () => businessDate(new Date());

export const daysAgoISO = (n: number) => businessDate(new Date(Date.now() - n * 86400_000));

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Minutes as hours with one decimal, a number (charts). */
export const hrsNum = (m: number) => Math.round((m / 60) * 10) / 10;

/** "3 Nov" from an ISO date (chart axes). */
export const shortDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** "YYYY-MM-DDTHH:mm" in the business zone, for datetime-local inputs. */
export const localDateTime = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: BUSINESS_ZONE, dateStyle: 'short', timeStyle: 'short' }).format(d).replace(' ', 'T');

/** The instant meant by what was typed in such an input (the business zone has no daylight saving). */
export const businessInstant = (local: string) => new Date(`${local.slice(0, 16)}:00+05:30`).toISOString();
