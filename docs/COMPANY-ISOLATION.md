# Company isolation

One company must never reach another's records. Two independent layers enforce this.

## The two layers

1. **The application.** Every query filters by company, and `mount()` refuses another company's ids with 404 before a handler runs ([lib/tenancy.ts](../apps/api/src/lib/tenancy.ts)).
2. **The database.** Row-level security is on for every company table (migration 025). Requests and background jobs connect with a restricted login with their company set, so a query that forgets its filter sees only that company, and a write that touches or links to another company's record is refused.

The second layer exists for the day the first has a bug.

## Two database logins

| | Owner login (`DATABASE_URL`) | Restricted login (`APP_DATABASE_URL`, `geoattend_tenant`) |
|---|---|---|
| Owns the tables | Yes | No |
| Limited by row-level security | No | **Yes** |
| Superuser | Refused in production | Never |
| Can change the schema or policies | Yes | No |
| Can become the other login | n/a | No |
| Used by | Migrations, and the list below | Every signed-in request and every background job |

[db/pool.ts](../apps/api/src/db/pool.ts) keeps one connection pool for each. `withOrg(company, ...)` uses the restricted pool and sets the company on the connection.

**In production the API refuses to start** if the restricted login is a superuser, can bypass row-level security, can create roles or databases, owns a table or can become the owner; if the owner login is a superuser; if `APP_DATABASE_URL` is missing; or if both URLs are the same login.

### What uses the owner login

| What | Why |
|---|---|
| `login`, `refresh`, `logout`, `signup`, and reading the user during sign-in checks | Nobody is known yet |
| `emailTaken()` | Sign-in is by address alone, so it must be unique across companies. It answers yes or no |
| `/api/v1/storage` upload and download | Authorised by a signed, short-lived token for one object, not a session |
| Listing which companies a job should visit, job bookkeeping, removing expired sign-in tokens | They are not company data |
| Stream re-checks (`recheckClients`) | Reads whether a signed-in user is still active |
| Sample company heartbeat | Development only; never in production |
| Migrations and scripts | They change the schema, or run by hand |

## Adding to the system

- **A new table** must have a policy. `test/isolation.test.ts` fails if any table has no row-level security.
- **A new view** must set `security_invoker = true`, or it reads as its owner. The same test checks this.
- **New routes** get all this from `mount()`. Do not register routes on the router directly.
- **New jobs** go through `eachCompany` ([modules/jobs/runner.ts](../apps/api/src/modules/jobs/runner.ts)).
- **Never call `getPool().query()`**: it uses the owner login. Use `q`, `one` or `tx`.
- **Join the attendance views through `workJoin()`**, not directly. A plain join made the attendance list 85 times slower at about 20,000 records.

## Setting up production

Run once as a database administrator:

```sql
CREATE ROLE geoattend_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '...';
CREATE ROLE geoattend_tenant LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '...';
CREATE DATABASE geoattend OWNER geoattend_owner;
\c geoattend
ALTER SCHEMA public OWNER TO geoattend_owner;
```

Then `DATABASE_URL` uses `geoattend_owner` and `APP_DATABASE_URL` uses `geoattend_tenant`. `docker/db-init/01-roles.sh` does this for docker-compose.

Other requirements:

- PostgreSQL 15 or newer (`security_invoker`).
- Connect directly or through a pooler in **session** mode. Transaction pooling would mix up the company setting on a connection, and PgBouncer refuses the startup option that pins connections to UTC.
- A logical restore needs the role to exist first. `npm run db:restore` creates it. This has **not** been run end to end: the embedded database has no `pg_dump` or `pg_restore`, so `db:backup` and `db:restore` need the PostgreSQL client tools. `db:backup:online` does not, and is what has been used and verified. Try a logical restore on the test server.

## Known limits

- **SQL injection on a restricted connection could change its own company setting.** `app.org_id` is an ordinary setting, so injected SQL could point it at another company and read that company's rows. It could not become another login, read the job tables, change the schema or disable the policies. Every query is parameterised and the injection tests find no way in, so there is no known route to this, but the database alone does not stop it.
- **The API process holds both logins.** Taking over the running process gives both. They cannot be separated without moving sign-in to its own service.
- **No database constraint ties a record's employee to its workplace's company.** Restricted writes are checked by the policies, which test every reference. Writes on the owner login are not, which is why it does almost nothing. Composite foreign keys would need a company column on every table.
- **Signed photo links are bearer links.** Anyone holding one can use it until it expires: 120 seconds for a download.
- An administrator can learn that an address is already registered somewhere, from the `EMAIL_TAKEN` message. Sign-in needs that, and it reveals nothing about which company.
- `sample_plan` and `sample_meta`, in the demo database only, have no company column. The restricted login has no access to them.

## How it is tested

Every test run connects as a non-superuser owner, with requests and jobs on the separate restricted login, as in production.

- `test/isolation.test.ts`: careless queries and hostile writes against every table, what the login cannot do, and connection reuse under load.
- `test/penetration.test.ts`: two companies that signed up through the real API attack each other: every route, every role, SQL injection in every query parameter, forged tokens, photo links and exports.
- `test/tenancy.test.ts`: every admin route with another company's ids, and every list for leaks.
- `test/jobs.test.ts`: jobs run on the restricted login, one company at a time.
