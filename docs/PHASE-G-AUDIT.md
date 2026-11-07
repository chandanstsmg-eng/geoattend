# Phase G: UI/UX audit and baseline

Written before any Phase G code change, on `production-remediation` at `b1ac0e8`.

**How it was done.** Every admin page was read, then opened in real headless Chrome 156 as owner and as supervisor at 1440, 820 and 390 px wide (94 page loads) on a production build, with axe-core checks. Data is a disposable reseeded copy of the sample company with a live working-day state. The mobile app was audited by reading its code only; nothing ran on a phone.

## Verdict

GeoAttend is not a rough product that needs a new look. Its design tokens, contrast notes, keyboard handling, loading and empty states, and accessible charts with table views are real work worth keeping. The main problems are these:

1. Some functional bugs sit behind the interface.
2. The API returns analytics that no screen shows.
3. The owner and supervisor share a single 3,700 px page.
4. The map says more than it knows in a few places.
5. On the phone, a pending record looks confirmed.

So Phase G extends the existing kit and restructures the screens. It does not replace them, and it adds no chart or UI dependency.

## Baseline measurements

| Measure | Baseline |
|---|---|
| Page loads tested / failed | 94 / 0 |
| Failed API calls | 0 |
| Pages that scroll sideways | 0 |
| Console errors | 12, all from the refused Maps key |
| axe `color-contrast` | 1,269 nodes on 19 pages |
| axe `aria-prohibited-attr` | 300 nodes on 1 page |
| axe `scrollable-region-focusable` | 8 nodes on 2 pages |
| Page height, owner overview | 3,704 px |
| Page height, reports | 6,327 px |
| API calls on overview load | 15, of which 12 unique |
| Pages fetching something twice | All of them |
| JS files in the dashboard build | 45 files, 1,405 KB uncompressed |

API, 25 calls each, sample data of 42 employees:

| Endpoint | p50 | p95 |
|---|---|---|
| `/analytics/dashboard`, 7 days + comparison | 187 ms | 197 ms |
| `/analytics/dashboard`, 30 days + comparison | **1,432 ms** | **1,627 ms** |
| `/reports/monthly` | 165 ms | 346 ms |
| `/attendance?limit=50` | 52 ms | 83 ms |
| `/reports/overview` | 17 ms | 23 ms |
| `/tracking/live` | 12 ms | 27 ms |
| `/employees?limit=50` | 11 ms | 16 ms |

**Causes found:**
- Every page double-fetches because the live connection's `hello` event runs the "after a reconnect" refresh on the first connection too (`lib/live.tsx:45`).
- The dashboard's 30-day time comes from running the roster queries one day at a time, for 60 days, when the comparison is on.

## Functional bugs found

| # | Severity | Finding | Confirmed by |
|---|---|---|---|
| F1 | High | `Field` wraps everything in a `<label>`, so clicking a caption activates the first control inside. Clicking "Permitted radius" changed the field | Browser |
| F2 | High | Multi-value settings re-parse on every keystroke, so commas vanish: WhatsApp numbers, e-mail recipients, radius presets | Code |
| F3 | High | Reports says every figure and export follows the filters. Several don't: the daily table, shift CSV, monthly report and detailed CSVs each ignore some filters | Code |
| F4 | High | The map legend calls `arriving` and `overtime` people "Inside zone". `review` is "Outside zone" on the map but "not yet on site" in the list | Code |
| F5 | High | A refused Maps key leaves a broken map with no fallback; only a missing key is handled | Browser |
| F6 | Medium | Failures look like real data: a map error shows "0 not checked in", a roster error shows "Nobody rostered", payroll shows ₹0 | Code |
| F7 | Medium | Lists stop at 200 or 1,000 rows with no notice | Code |
| F8 | Medium | Overtime bulk approve includes selected rows hidden by a filter, with no confirmation | Code |
| F9 | Medium | Each `attendance.recorded` event reloads photo thumbnails and writes a new audit entry | Code |
| F10 | Medium | Overview tiles for On site, Outside and Phone silent all open the same unfiltered map | Code |
| F11 | Low | Supervisors can reach `/workplaces` and `/shifts` by URL and see edit controls that fail on save. The API refuses them, so this is a UI issue, not a security one | Code |
| M1 | High | Phone: a pending record shows a green "Attendance recorded" and "✓ Checked in", and the success screen falls back to `VERIFIED` | Code |
| M2 | High | Phone: a cold start offline hides Continue shift, End shift and SOS behind an error | Code |
| M3 | Medium | Phone: Home goes stale because foreground refetch is not wired | Code |
| M4 | Medium | Phone: announcements, tasks and earnings disappear when empty or read, with no other route | Code |

## Findings by area

**Visual hierarchy.** The overview answers "right now" and "what needs attention" well, then runs on through a map, activity, KPIs, charts and a 25-row table. Owner figures such as supervisors, workplaces and location distribution are missing even though the API returns them.

**Repetitive components.** `Stat` duplicates `Kpi` (overtime, operations), hand-built tiles appear in reports, sections stand in for `Card`, and `<p>` stands in for `Callout`.

**Unnecessary tables.** Location staffing for supervisors is a 10-column table where a ranked list reads better. Most other tables earn their place and already stack into cards on phones.

**Spacing and typography.** Tokens exist but are mixed: `text-xs` with `text-caption`, `text-sm` with `text-body-sm`, `mt-5` with `mt-6`. "Workplace" and "workspace" are mixed about evenly, sometimes on one page.

**Colour contrast.** The 1,269 failures come from two causes. Gray-500 falls to 4.2–4.4:1 on tinted backgrounds, and gray-400 is used for text at 2.56:1. Both are fixable in the tokens. On the phone, white on orange is 3.56:1 on every primary button.

**Navigation.** The grouped sidebar with rail mode works well. `/tasks` has no menu entry by an earlier deliberate decision, so it is reachable by URL only.

**Missing analytics.** Not shown although the API returns them: supervisor performance, location distribution, overtime status, hours by day and by employee on the owner overview.

**Empty, loading and error states.** Good on most pages through `QueryState`. The gaps are the failures in F6.

**Responsive.** No sideways scrolling at any tested width. Touch targets under 24 px remain on several pages (25 on the overview, 10 on reports). The staffing grid has no phone layout, and `gestureHandling="greedy"` can trap scrolling over the map.

**Map.** Stale handling is strong: hollow dashed markers, freshness labels and a stale filter. Without working Google Maps the fallback shows one workplace at a time with no overview. Location history exists, but only through the employee drawer.

**Accessibility.** Schematic markers are mouse-only, `aria-label` sits on plain spans (the 300 nodes), scrollable tables can't take focus, and some status is colour-only (roster bars, overdue tasks). On the phone, `accessible` grouping and live regions are mostly missing.

**Performance.** Causes are listed above, plus: search fetches on each keystroke, several polled queries are also refreshed by live events, and the home screen on the phone polls every 15 s even off shift.

## Keep as it is

- Attendance board, `QueryState`, `Tabs`, `Menu`, the phone table cards, `Kpi` and `StatStrip`.
- Attendance evidence drawer and audited photo access.
- Stale-location handling and freshness labels.
- Payroll approve, lock and reopen flow, which stays off.
- Workplace editor, Privacy page.

**On the phone, these must not change** because they guard verification: `capture.tsx` guards and step order, server-driven eligibility, the offline gate, `openCaptureFlow`, `saveCheckOut`, and starting through `startShift()`. Any new shortcut goes to `/shift`, never straight to capture.

## Limits of this audit

- Mobile findings come from reading the code. Nothing ran on a phone.
- Real Google Maps could not be viewed: the key refuses this test address.
- The sample company is small (42 employees). Load at larger sizes is not measured here.
