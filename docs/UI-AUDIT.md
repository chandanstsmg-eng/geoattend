# Interface and code audit (4 Nov 2026)

Scope: the admin console (`apps/admin`) and the public site (`apps/web`). The API and mobile app were not changed in this pass. A copy of the source from before the pass is in `data/backups/source-before-ui-pass-2026-11-04.tar.gz`, because the project is not under git.

## Stack

Both web apps are Next.js 16 with React 19 and Tailwind 4 (not Vite). The console uses TanStack Query, Radix dialogs and the Google Maps library; there are no unused dependencies. It talks to the Express API through a same-origin `/api` rewrite with first-party cookies.

## What was found

| Area | Finding | Status |
|---|---|---|
| Layout | A row of separate cards opened most pages; every tile had an icon in a square; tiles sat at different heights | Replaced by one `StatStrip` panel; icons removed |
| Overview | The first screen was a list of metrics and did not answer "is my workforce where it should be?" | New order: right now, needs attention, map and activity, period figures, trends, today's board |
| Colour | Orange meant action, warning, overtime and selection | Orange is for primary actions only; amber = watch, red = critical, teal = positive, navy = selection and charts |
| Type | 83 ad-hoc font sizes, including 11.5, 12.5 and 13.5 px | Named scale: `caption`, `xs`, `body-sm`, `sm`, `title` |
| Feedback | Only 6 of 63 actions confirmed success; several failures were silent, including SOS acknowledge | Toast system; feedback declared on the mutation (`meta.success`, `meta.toastError`) |
| Failure states | A failed query read as 0 on the Overview, Employees and Live map; two skeletons never resolved | Error and retry shown instead |
| Crashes | No error boundary or not-found page | `app/(dash)/error.tsx`, `app/not-found.tsx` |
| Loading | Spinners | `LoadingRows` and `StatStripSkeleton`, shaped like the content |
| Risky actions | Run retention, Mark paid and Disable workspace had no confirmation | Confirmation dialogs stating the effect |
| Markup | 17 buttons nested inside links (invalid, and tabbed twice) | `LinkButton` |
| Keyboard | Clickable rows opened on Enter only; the closed phone menu stayed in the tab order | `rowKeys` (Enter and Space); closed menu hidden |
| Touch | Roster on a phone: a 920 px grid with 336 undersized targets | One-day list with day tabs |
| Responsive | Overflow at 360 px on Attendance and Reports | Fixed |
| Data bugs | Three date defaults used UTC, so the wrong day near midnight IST; the two face-result tables disagreed | Local dates; one `FACE_RESULT` |
| Duplication | `hrsNum`, `shortDay` and button classes copied between files | Moved to `lib/format.ts` and `components/ui.tsx` |
| Dead code | Two empty files in the repo root, an unused component, imports and a prop | Removed |
| Public site | Navy and orange were not the brand's; button text about 3.6:1 contrast; off-brand blue and favicon | Brand tokens, AA button colour, console icon |

Checked and found clean: every internal link resolves, all CSV routes exist, no lorem or TODO text, all chart data comes from the API, no icon-only button lacks a label, no testimonials or customer numbers on the public site.

## Design rules

- **Colour:** one job each, as above. Status is never colour alone.
- **Summaries:** figures go in one `StatStrip`, not a card row. A figure is a link or button only if it leads somewhere.
- **Panels:** `Card`; 8 px radius, one light shadow, 1 px border.
- **Buttons:** one primary (orange) per area; secondary (white) otherwise; `LinkButton` for navigation and downloads.
- **Motion:** 100–160 ms, only for something opening or arriving; reduced-motion is respected.
- **Feedback:** every action that changes data declares its success message; failures appear inline in forms, otherwise as a toast.

## Not done

See the "Pre-launch" and "Interface pass" notes in [STATUS.md](STATUS.md) for what was verified. Remaining items, in priority order:

1. Split the largest page files (`attendance`, `overtime`, `layout`, `employee-drawer`, `settings`). This was left alone to avoid risk without version control.
2. Move the date pairs to one `DateRangeInputs`, and the 9 hand-built panels to `Card`.
3. Saved views, column chooser and bulk actions on tables; a global date range in the header.
4. Hindi strings still hard-coded in English on the public site, an Open Graph image, and privacy and terms links.
5. Public site claims that the project's own status notes do not support: "Works on any Android or iPhone" (iOS is untested), "no buddy punching", "Set up your team in under 15 minutes", "Fake GPS gets flagged" as an absolute. These need a business decision.
