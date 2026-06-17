# Deploying REG AI (Phase 8c)

One Docker image runs three roles: **web** (`next start`), **worker** (the ingestion poller),
and **release migrations** (`drizzle-kit migrate`, run automatically before each deploy).
Default target is **Fly.io**; a Railway path is at the bottom.

The live deploy needs **your** cloud account — these are the exact steps.

---

## 1. Prerequisites
- A **PostgreSQL 16 database with the `pgvector` extension available.** Easiest: a managed
  provider that ships pgvector — **Neon** or **Supabase** (both have it built in). Fly Postgres
  works too but needs a pgvector-enabled image; managed is simpler for the demo.
- The [`fly` CLI](https://fly.io/docs/flyctl/install/) and a Fly account (`fly auth login`).
- A funded `OPENAI_API_KEY`.

## 2. Provision DB roles (one-time, run as the DB admin/owner)
Tenant isolation depends on the app connecting as a **non-superuser** role, and the cross-tenant
worker as a **BYPASSRLS but non-superuser** role. Run this once against the prod DB (psql as the
owner). Replace the passwords:

```sql
-- App role: RLS APPLIES (never superuser/bypassrls). Migration 0002 also grants these
-- (IF NOT EXISTS makes the role create idempotent); we pre-create it to set a strong password.
CREATE ROLE reg_app LOGIN PASSWORD 'CHANGE_ME_app';

-- Worker role: claims jobs across tenants, so it BYPASSES RLS — but is NOT a superuser.
CREATE ROLE reg_worker LOGIN PASSWORD 'CHANGE_ME_worker' BYPASSRLS;
GRANT USAGE ON SCHEMA public TO reg_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO reg_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO reg_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO reg_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO reg_worker;
```

(The `vector` extension + all tables/RLS are created by the migrations in step 4 — the admin role
just needs permission to `CREATE EXTENSION`, which managed providers grant the owner.)

## 3. Create the app + set secrets
```bash
fly launch --no-deploy            # creates the app from fly.toml (pick a name/region)

# Three DB connection strings (admin for migrations, reg_app for web, reg_worker for worker) + the key.
fly secrets set \
  MIGRATION_DATABASE_URL="postgres://<admin>:<pw>@<host>/<db>?sslmode=require" \
  DATABASE_URL="postgres://reg_app:CHANGE_ME_app@<host>/<db>?sslmode=require" \
  WORKER_DATABASE_URL="postgres://reg_worker:CHANGE_ME_worker@<host>/<db>?sslmode=require" \
  OPENAI_API_KEY="sk-..."
```

## 4. Deploy
```bash
fly deploy
```
This builds the image, runs `release_command` (`npm run db:migrate` → creates the `vector`
extension, all tables, RLS policies, and the `reg_app` grants), then starts the `web` + `worker`
machines.

## 5. Verify
```bash
curl https://<your-app>.fly.dev/api/health     # -> {"db":"ok","vector":"0.8.2"}
```
Then register a restaurant, upload a PDF, and ask a question — the worker should ingest it and
`/api/ask` should answer grounded with citations (or decline).

## 6. CI (from Phase 8a)
On GitHub: add the **`OPENAI_API_KEY`** repo secret (activates the `eval` job) and enable
**branch protection** on `main` requiring the `verify` check.

---

## Railway alternative
Railway can build the same `Dockerfile`. Create the project from the repo, then:
- Add a **web** service (start command `npm start`) and a **worker** service (`npm run worker`)
  from the same repo/image.
- Set the same four env vars on both services.
- Run migrations once (`npm run db:migrate` via a one-off command or a deploy hook) — Railway has
  no direct `release_command` equivalent, so run it as a pre-deploy step or manually after the
  first deploy.
- Point HTTP at the web service; the worker needs no public port.
