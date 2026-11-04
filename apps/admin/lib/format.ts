export function fmtDateTime(v: string | Date | null | undefined, tz?: string) {
  if (!v) return '—';
  return new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', ...(tz ? { timeZone: tz } : {}) });
}

export function fmtTime(v: string | Date | null | undefined, tz?: string) {
  if (!v) return '—';
  return new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', ...(tz ? { timeZone: tz } : {}) });
}

/** Hours and minutes only, for dense tables (the full time stays in the record view). */
export function fmtClock(v: string | Date | null | undefined, tz?: string) {
  if (!v) return '—';
  return new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
}

/** "Friday, 31 October 2026" for page subtitles. */
export function fmtLongDate(v: string | null | undefined) {
  if (!v) return '—';
  return new Date(`${v.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function fmtDate(v: string | null | undefined) {
  if (!v) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : new Date(v);
  return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
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

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const daysAgoISO = (n: number) => {
  const d = new Date(Date.now() - n * 86400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Minutes as hours with one decimal, a number (charts). */
export const hrsNum = (m: number) => Math.round((m / 60) * 10) / 10;

/** "3 Nov" from an ISO date (chart axes). */
export const shortDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** "YYYY-MM-DDTHH:mm" in the browser's time zone, for datetime-local inputs. */
export const localDateTime = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
