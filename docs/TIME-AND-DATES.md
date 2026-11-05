# Time and dates

The rules every part of GeoAttend follows, and how they are checked.

## Rules

- **Timestamps are stored in UTC** (`timestamptz`). No column stores a local time without a zone.
- **A business date is the date on the wall at the workplace.** For a shift that is the shift's own time zone. For anything company-wide (today on the dashboard, a report range, the default month) it is the zone of the company's first active workplace, or `Asia/Kolkata` if it has none yet.
- **Nothing depends on the zone of the server or the database.** Database connections are pinned to UTC, plain date arithmetic runs in UTC, and SQL's `CURRENT_DATE` is not used. Between 00:00 and 05:30 IST the UTC date is still yesterday, so it would give the wrong day for five and a half hours every night.
- **An overnight shift belongs to the date it started.** A 22:00 to 06:00 shift on 31 March is one day of attendance, on 31 March, in March's totals, whenever the person checks in or out. Leave and holidays are judged on that date too.
- **Date filters on logs use the business day.** Audit logs, notifications, geofence events and absences filtered for 1 April return what happened from 00:00 to 23:59:59 IST on 1 April.

Helpers: [apps/api/src/lib/dates.ts](../apps/api/src/lib/dates.ts) and [apps/api/src/lib/shift-window.ts](../apps/api/src/lib/shift-window.ts).

## Screens and exports

- The dashboard shows times and "today" in `Asia/Kolkata`, whatever the zone of the browser, so an owner travelling abroad sees the same day as the site. Screens that know a workplace's own zone pass it.
- The phone uses its own calendar date.
- CSV exports keep their UTC columns and add a local column, read as it was on the wall at the workplace.

## Known limits

- A company with workplaces in several time zones has one company-wide "today" and one zone for log filters: the zone of its first active workplace. Shifts and rosters still use their own zone. All sample data, and every expected customer, is in India.
- The dashboard's fixed zone is the same limit on the screen. A company outside India would need a company time zone setting first.
- Column defaults of `effective_from` in the database are still `CURRENT_DATE` (from migration 001). The API always passes the date, so they are not used; only direct SQL would reach them.
- A shift's duration on manual records with no session is computed from its clock times, so it can be an hour out on the night clocks change. India has no daylight saving.

## How it is tested

`apps/api/test/dates.test.ts` covers 00:00 UTC and 00:00 IST, month and year ends, a leap day, overnight shifts through the real API, and the database clock in zones far from UTC. It also fails if `CURRENT_DATE` or a date taken from a UTC string comes back.

The application clock is frozen for tests that need an exact moment. The database clock cannot be frozen, so those checks use zones whose date differs from UTC right now.

To prove independence from the server's zone, run the file under other zones:

```
TZ=Asia/Kolkata npx vitest run test/dates.test.ts
TZ=America/Los_Angeles npx vitest run test/dates.test.ts
TZ=Pacific/Kiritimati npx vitest run test/dates.test.ts
```
