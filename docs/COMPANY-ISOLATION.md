# Company isolation

One company must never reach another's records. Two independent layers enforce this.

## The two layers

1. **The application.** Every query filters by company, and `mount()` refuses another company's ids with 404 before a handler runs ([lib/tenancy.ts](../apps/api/src/lib/tenancy.ts)).
2. **The database.** Migration 025 turns on row-level security for every table. Each request of a signed-in user runs as the role `geoattend_tenant` with its company set, so a query that forgets its filter sees only that company, and a write that touches or links to another company's record is refused.

The second layer exists for the day the first has a bug.

## How a request gets its company

`mount()` in [lib/http.ts](../apps/api/src/lib/http.ts) runs each handler inside `withOrg(user.orgId, ...)`. [db/pool.ts](../apps/api/src/db/pool.ts) sets the role and company on the connection before any query in that scope, and resets them when the connection next serves something else.

| Runs as | What | Why |
|---|---|---|
| Restricted role, one company | Every route of a signed-in user | The normal case |
| Owner, no limit | `login`, `refresh`, `logout`, `signup`, and reading the user during sign-in checks | Nobody is known yet |
| Owner, no limit | `emailTaken()` | Sign-in is by address alone, so it must be unique across companies. It answers yes or no and returns nothing else |
| Owner, no limit | `/api/v1/storage` upload and download | Authorised by a signed, short-lived token for one object, not a session |
| Owner, no limit | Background jobs, migrations, scripts | They serve every company |

## Adding to the system

- **A new table** must be added to a migration with its policy. `test/isolation.test.ts` fails if any table has no row-level security.
- **A new view** must set `security_invoker = true`, or it reads as its owner and sees every company. The same test checks this.
- **New routes** get all this from `mount()`. Do not register routes on the router directly.
- **Never call `getPool().query()`**: it skips the company setting. Use `q`, `one` or `tx`.

## Deployment requirements

- PostgreSQL 15 or newer (`security_invoker`).
- The user that runs migrations must be able to create the role, or a database administrator creates it first:

  ```sql
  CREATE ROLE geoattend_tenant NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  GRANT geoattend_tenant TO <migration_user>;
  ```

- The API must connect directly or through a pooler in **session** mode. Transaction pooling (PgBouncer's default for many hosted databases) would mix up the per-connection company setting, and PgBouncer also refuses the startup option that pins connections to UTC.
- A logical restore needs the role to exist first. `npm run db:restore` creates it.

## Known limits

- **Layer two guards against mistakes, not against SQL injection.** The API's database login can always leave the restricted role, so an attacker able to run arbitrary SQL could too. Every query is parameterised, so there is no known route to that. Closing it fully needs a separate database login for requests that is not a member of any wider role.
- **Background jobs are not limited by the database.** They rely on their own queries. Phase F reviews them.
- In the local development database the login is a superuser. Production should use an ordinary owner role. That setup has been designed but **not yet tested on a real server**: all testing here ran as a superuser switching to the restricted role.
- `sample_plan` and `sample_meta`, which exist only in the demo database, have no company column. The restricted role has no access to them at all.
- An administrator can learn that an address is already registered somewhere, from the `EMAIL_TAKEN` message. That is needed for sign-in to work and reveals nothing about which company.

## How it is tested

- `test/isolation.test.ts`: careless queries and hostile writes run as a company against every table, connection reuse under load, and direct API attempts with another company's ids on every employee route.
- `test/tenancy.test.ts`: every admin route with another company's ids and every list for leaks.
