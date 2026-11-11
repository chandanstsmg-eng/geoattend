/**
 * Shift windows. A shift is defined by local start/end times, a time zone and
 * days of the week; overnight shifts (end ≤ start) end on the next day.
 * Tracking is authorised from `earlyStartMinutes` before the start until
 * `endGraceMinutes` after the end — never outside that window.
 */
import { DateTime } from 'luxon';

export interface ShiftDef {
  start_time: string; // HH:MM[:SS]
  end_time: string;
  timezone: string;
  days_of_week: number[]; // ISO 1 = Monday … 7 = Sunday
}

export interface ShiftInstance {
  shiftDate: string; // local date on which the shift starts
  startsAt: Date;
  endsAt: Date;
  windowOpensAt: Date;
  windowClosesAt: Date;
}

function hm(t: string) {
  const [h, m] = t.split(':').map(Number);
  return { hour: h ?? 0, minute: m ?? 0 };
}

export function instanceFor(shift: ShiftDef, localDate: DateTime, earlyMin: number, graceMin: number): ShiftInstance {
  const start = localDate.set({ ...hm(shift.start_time), second: 0, millisecond: 0 });
  let end = localDate.set({ ...hm(shift.end_time), second: 0, millisecond: 0 });
  if (end <= start) end = end.plus({ days: 1 });
  return {
    shiftDate: localDate.toISODate()!,
    startsAt: start.toJSDate(),
    endsAt: end.toJSDate(),
    windowOpensAt: start.minus({ minutes: earlyMin }).toJSDate(),
    windowClosesAt: end.plus({ minutes: graceMin }).toJSDate(),
  };
}

/** Roster dates (inclusive, local YYYY-MM-DD) an employee is assigned to a shift; `to` null = open-ended. */
export interface DateRange {
  from: string;
  to: string | null;
}

const inRanges = (isoDate: string, ranges?: DateRange[]) => !ranges || ranges.some((r) => isoDate >= r.from && (!r.to || isoDate <= r.to));

/** The instance whose authorised window contains `now`, if any (only on rostered dates when `ranges` is given). */
export function currentInstance(shift: ShiftDef, now: Date, earlyMin: number, graceMin: number, ranges?: DateRange[]): ShiftInstance | null {
  const local = DateTime.fromJSDate(now, { zone: shift.timezone }).startOf('day');
  for (const offset of [0, -1, 1]) {
    const day = local.plus({ days: offset });
    if (!shift.days_of_week.includes(day.weekday) || !inRanges(day.toISODate()!, ranges)) continue;
    const inst = instanceFor(shift, day, earlyMin, graceMin);
    if (now >= inst.windowOpensAt && now <= inst.windowClosesAt) return inst;
  }
  return null;
}

/**
 * The next instance starting after `now`: within 8 days, or — with roster `ranges` — the first
 * rostered date that runs (a range may start weeks ahead).
 */
export function nextInstance(shift: ShiftDef, now: Date, earlyMin: number, graceMin: number, ranges?: DateRange[]): ShiftInstance | null {
  const local = DateTime.fromJSDate(now, { zone: shift.timezone }).startOf('day');
  const starts = ranges ? ranges.map((r) => DateTime.max(local, DateTime.fromISO(r.from, { zone: shift.timezone }))) : [local];
  let best: ShiftInstance | null = null;
  for (const begin of starts) {
    for (let offset = 0; offset <= 8; offset++) {
      const day = begin.plus({ days: offset });
      const iso = day.toISODate()!;
      if (!shift.days_of_week.includes(day.weekday) || !inRanges(iso, ranges)) continue;
      const inst = instanceFor(shift, day, earlyMin, graceMin);
      if (inst.windowOpensAt > now) {
        if (!best || inst.startsAt < best.startsAt) best = inst;
        break;
      }
    }
  }
  return best;
}

/** Whether a shift runs on the given local date. */
export function runsOn(shift: ShiftDef, isoDate: string) {
  const d = DateTime.fromISO(isoDate, { zone: shift.timezone });
  return shift.days_of_week.includes(d.weekday);
}

export function todayIn(tz: string, now = new Date()) {
  return DateTime.fromJSDate(now, { zone: tz }).toISODate()!;
}

/** Legacy IANA names some browsers still report, mapped to the current ones (one name per zone everywhere). */
const TZ_ALIASES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
};
export const canonicalTimezone = (tz: string) => TZ_ALIASES[tz] ?? tz;

/**
 * A zone this server and PostgreSQL both read the same way: an IANA name ("Asia/Kolkata") or UTC.
 * Abbreviations are refused: "IST" is India to the date library but Israel to PostgreSQL, which put SQL
 * dates and lateness 3.5 hours off (Phase I review). Fixed offsets too ("+05:30", "UTC+5"): no daylight rules.
 */
export function isValidTimezone(tz: string) {
  const name = canonicalTimezone(tz.trim());
  if (name !== 'UTC' && !/^[A-Z][A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(name)) return false;
  return DateTime.local().setZone(name).isValid;
}
