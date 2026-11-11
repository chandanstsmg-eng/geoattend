# Platform administration, companies and sign-in

GeoAttend serves many companies from one installation. This page covers the four kinds of account, how they are created, editions and subscriptions, and the development demo company. Migration: `032_platform_and_subscriptions` ([MIGRATIONS.md](MIGRATIONS.md)).

## The four account roles

| Role | Signs in at | Sees | Created by |
|---|---|---|---|
| **Platform super administrator** | Dashboard `/platform/login` | Every company's registration, status, plan, active-people counts and owners. Never attendance, locations, photos, leave or pay | Whoever runs the server, with `npm run platform:admin` (no web sign-up exists) |
| **Company owner** | Dashboard `/login` | Their whole company | The platform (new company or "Add owner"), another owner, or self sign-up when it is open |
| **Supervisor** | Dashboard `/login` | Only their own team, at their own workplaces, including SOS | An owner (Supervisors page) |
| **Employee** | GeoAttend mobile app | Their own attendance, shifts, leave and notifications | An owner (Employees page, or import) |

Platform administrators are a separate table with their own token key, cookies (scoped to `/api/v1/platform`) and CSRF token. A company token is refused by the platform API and the other way round. A platform sign-in rotates its token on every refresh, ends if a used token comes back, idles out after 2 hours and ends after 12 hours whatever happens.

## Creating accounts

**First platform administrator** (on the server, after a backup and after migration 032 is applied):

```
npm run platform:admin -w @geoattend/api -- create you@yourcompany.com "Your Name"
npm run platform:admin -w @geoattend/api -- list
npm run platform:admin -w @geoattend/api -- reset-password you@yourcompany.com
npm run platform:admin -w @geoattend/api -- deactivate someone@yourcompany.com
```

`create` and `reset-password` print a random temporary password once. It must be changed at the first sign-in; until then only the password change is allowed. Nothing is hard-coded. The script never applies migrations itself.

**Companies and their owners**: Platform › Companies › New company: name, registration details, edition, subscription (trial or active, start, term or renewal date), first owner. The owner gets an **invitation link** by default (they choose their own password), or a one-time temporary password.

**Supervisors and employees**: the owner adds them as before. "Create a temporary password" stays the default; "Send an invitation link" lets the person choose their own. Someone who has never signed in can be sent a new link; the old one stops working.

**Links.** Invitations last 7 days, password resets 60 minutes. Each works once, is stored only as a hash, and travels after `#` in the address so it never reaches server logs. Choosing a password from a link ends every existing sign-in of that account. With SMTP configured the link is e-mailed. Without it, an invitation link is shown to whoever sent it, to pass on privately, and in development the e-mail text is written to the API log. **In production without SMTP, "Forgot password" sends nothing**: set `SMTP_URL` and `EMAIL_FROM` before launch.

**Forgot password** is on the sign-in page and works for owners, supervisors and employees (employees use the web page, then sign in to the app). It answers the same whether or not the address exists. Platform administrators reset with the server script only.

**Sessions.** Account menu › Signed-in devices lists each sign-in (browser or phone) with "Sign out" and "Sign out everywhere else". Access tokens last 15 minutes; refresh tokens rotate and last 30 days unused (`REFRESH_TOKEN_TTL_DAYS`).

## Editions and subscriptions

| Edition | Employees | Supervisors | Optional modules |
|---|---|---|---|
| Starter | 25 | 2 | none |
| Professional | 200 | 10 | announcements, tasks, overtime |
| Enterprise | no limit | no limit | announcements, tasks, overtime, payroll |

Attendance, GPS geofencing, leave, approvals, reports, CSV exports, SOS and notifications are in every edition. Payroll also needs `PAYROLL_ENABLED` on the server, which stays off.

- Assigning an edition **copies** its limits and modules onto the company; the platform can then change them for that company. Editing an edition later does not change companies that already have it.
- **Limits** count active employees and active supervisors (owners are never counted). At the limit, adding or reactivating is refused with `PLAN_LIMIT_REACHED`. Lowering a limit deactivates nobody.
- **Modules** not in the plan: their dashboard pages are hidden and their administrator API answers `FEATURE_NOT_IN_PLAN`. The employee app is never restricted.
- **Expiry.** The renewal date is the last day covered. The platform overview lists companies ending within the warning period (14 days), in the grace period (7 days after), expired, or suspended. After the grace period the company's administrators can still sign in, view and export, but cannot change anything (`SUBSCRIPTION_EXPIRED`); employees keep recording attendance; **no data is removed or hidden**. Renewing restores everything at once.
- **Suspension** (platform, with a reason) refuses every sign-in and request of that company at once and ends its sign-ins. Nothing is deleted. Reactivating restores access.
- **Self sign-up** (`/signup`) stays open by default and starts the company on a Starter trial (30 days). The platform can close it or change the edition and trial length in Platform › Settings.
- Every platform action is in the platform audit log; actions on a company are also in that company's own audit log.

## Demo company (development only)

```
npm run demo:provision -w @geoattend/api -- --confirm-development
npm run demo:provision -w @geoattend/api -- --confirm-development --reset-passwords
```

Creates "GeoAttend Demo Company" (Professional): `owner@demo-company.test`, `supervisor1@` and `supervisor2@demo-company.test`, and `employee01` to `employee10@demo-company.test` (01–05 in supervisor 1's team, 06–10 in supervisor 2's), one workplace in Bengaluru and a 09:00–18:00 Monday–Saturday shift. Each account gets its own random temporary password and must change it at first sign-in. Passwords are never printed: they go to `<DATA_DIR>/demo-credentials/`, outside git. Delete the file once handed out.

It refuses to run with `NODE_ENV=production`, without `--confirm-development`, or on an external database unless `ALLOW_DEMO_ON_EXTERNAL_DB=1`. Nothing runs it automatically. Phone binding applies as usual: an employee's first sign-in on a new phone waits until an owner or supervisor approves the phone (Approvals › Approve phone, or in the employee's details).

## Open decisions

- **Owners are not counted against any limit.** A company could add extra owners (who can do more than supervisors) instead of supervisors. Decide whether owners count towards the supervisor limit, or get a limit of their own.
- **Background jobs still run for a suspended company** (reminders, summaries, escalations, push). Its people cannot sign in and its open live dashboards are disconnected within a minute, but scheduled messages may still go out. Decide whether jobs should skip suspended companies; skipping them also means no day-closing while suspended.
- Two platform console tabs refreshing at the same instant can end that platform sign-in (it looks like token reuse). Sign in again; the company side has a fix for this (migration 030) that the platform side does not yet copy.

## Not done

- The mobile app has no "Forgot password?" link; employees use the web page. Mobile was frozen and is still untested on real devices.
- No second factor for platform administrators.
- No billing or payment collection: subscriptions are set by hand by the platform.
