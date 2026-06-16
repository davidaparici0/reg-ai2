# Phase 8a Design — CI + eval gate (GitHub Actions)

**Date:** 2026-06-16
**FRs:** FR-027 (eval gate in CI — the "retrieval quality, observable" leg) + a CI safety net
that re-proves FR-001–026 on every change. FR-024 health route is already done/tested.
**Depends on:** the existing test harness (vitest + Docker Postgres), the two-DSN role split
(migration 0002 `reg_app`), and the eval harness (`eval:seed` / `eval:run`, Phase 3).

This is **slice 8a of Phase 8** (decomposed: 8a CI+eval · 8b observability · 8c deploy · 8d demo UI).
8a only delivers continuous integration; deploy, logging, metrics, and UI are later slices.

---

## 1. Goal & FR map

Every push/PR must automatically re-prove the suite that today only runs on David's laptop, and
`main` must additionally re-prove the grounding/fallback/isolation behaviour against the real model.

| FR | Where it lands |
|---|---|
| FR-027 (eval gate in CI) | `eval` job runs `eval:seed` + `eval:run` (the four auto-gates) on `main` + manual dispatch |
| FR-001–026 regression safety | `verify` job runs `tsc` + lint + `test` (179 tests) + `build` on every PR and push to `main` |

**Not in this slice:** Docker image / deploy (8c), structured logging (8b, FR-025), latency
metrics (8b, FR-027 latency leg), demo UI (8d), branch-protection *settings* (a one-time GitHub
repo admin action, noted as follow-up — not expressible in a workflow file).

## 2. Decisions locked in brainstorming

1. **One workflow file, two jobs** (`.github/workflows/ci.yml`): `verify` (fast, every push/PR)
   and `eval` (slow + costs OpenAI credits, gated). One file to read; the job split enforces the
   cost boundary.
2. **Eval is key-gated, `main` + manual only** (chosen over "every PR" and "manual-only"). The
   eval calls the real OpenAI API — running it on every PR would spend credits per push and fail
   on fork PRs (which can't read secrets). So: `verify` on every PR + push to `main`; `eval` on
   `push`→`main` and `workflow_dispatch`, and only when `OPENAI_API_KEY` is present (skips green otherwise).
3. **DB creds are the committed dev defaults, not secrets.** The CI Postgres is ephemeral, so
   `reg_dev_pw` / `reg_app_dev_pw` (already in `.env.example` + migration 0002) are reused
   directly. The **only** real secret is `OPENAI_API_KEY` (eval job).
4. **Lint becomes a real gate.** Fix the 3 pre-existing unused-var warnings and run lint with
   `--max-warnings 0`, so warnings can't silently accumulate. (In-scope, small.)
5. **No app/test code changes** beyond the 3 lint fixes. CI must pass against current `main` as-is.

## 3. Architecture & flow

```
.github/workflows/ci.yml
  on: push (branches: [main]), pull_request, workflow_dispatch
  job verify   (ubuntu, runs on every trigger)  -> tsc + lint(--max-warnings 0) + test + build
  job eval     (ubuntu, gated to main+dispatch) -> eval:seed + eval:run  [needs a funded key]
```

Both jobs run **directly on the runner** (not in a container) with a **Postgres service**
container, so the DB is reachable at `localhost:5432` (matching the local `DATABASE_URL`).

**Postgres service (both jobs):**
```
image: pgvector/pgvector:pg16          # same image as docker-compose.yml → pgvector present
env:   POSTGRES_USER=reg, POSTGRES_PASSWORD=reg_dev_pw, POSTGRES_DB=reg_ai
ports: 5432:5432
health: pg_isready (so steps wait until the DB accepts connections)
```

**`verify` job steps:**
1. `actions/checkout`
2. `actions/setup-node` (Node 22, `cache: npm`) → `npm ci`
3. **Migrate** — `npm run db:migrate` with `MIGRATION_DATABASE_URL=postgres://reg:reg_dev_pw@localhost:5432/reg_ai`.
   This applies 0000–0006: creates the `vector` extension, the `reg_app` NOSUPERUSER role, and all
   RLS — so CI exercises the *same* tenant isolation as local.
4. `npx tsc --noEmit`
5. `npm run lint -- --max-warnings 0`
6. `npm test` — with `DATABASE_URL=postgres://reg_app:reg_app_dev_pw@localhost:5432/reg_ai` and
   `WORKER_DATABASE_URL=postgres://reg:reg_dev_pw@localhost:5432/reg_ai`. (`test/setup.ts`'s
   `dotenv/config` no-ops without a `.env` and won't clobber these process-env values.)
7. `npm run build`

**`eval` job** (gated):
- Job-level `if:` — `github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref == 'refs/heads/main')`.
- Same checkout → setup-node → `npm ci` → migrate.
- **Key guard** — a step reads `OPENAI_API_KEY` from secrets into env and writes
  `has_key=true|false` to `$GITHUB_OUTPUT` (secrets can't be used in a job `if:`, so we gate the
  eval *steps* on this output). When absent: the job logs "no key — eval skipped" and ends green.
- When present: `npm run eval:seed` then `npm run eval:run` (env: the same DB URLs +
  `OPENAI_API_KEY`). `eval:run` already exits non-zero on any gate regression → red check.

## 4. Error handling

| Situation | Behaviour |
|---|---|
| Any `verify` step fails (tsc/lint/test/build) | job red → PR blocked (once branch protection is set) |
| `eval:run` gate regresses (fallback/isolation/probe) | `eval` job red on `main` |
| `OPENAI_API_KEY` absent (fork PR, or not yet configured) | `eval` steps skipped, job green — never a false red |
| Postgres not ready | `pg_isready` health check holds steps until it is |
| Migration fails in CI | `verify` red at the migrate step (caught before tests) |

## 5. Testing & Definition of Done

CI is itself the test surface, so "done" is observed from an actual run:
- **Open a PR** → `verify` runs and is **green** (tsc + lint@0-warnings + 179 tests + build); `eval` does **not** run.
- **Push to `main`** (or `workflow_dispatch`) → `eval` runs; **green** if `OPENAI_API_KEY` is set
  (four eval gates pass), **cleanly skipped-green** if not.
- `.github/workflows/ci.yml` committed; the 3 lint warnings fixed (`npm run lint -- --max-warnings 0`
  passes locally); `tsc` / `npm test` / `npm run build` still green locally.
- **Follow-up (manual, documented not automated):** enable branch protection on `main` requiring
  the `verify` check; add the `OPENAI_API_KEY` repo secret to activate the eval gate.

## 6. Out of scope (later slices / explicitly deferred)

- **8b:** structured request logging (FR-025), latency instrumentation (FR-027 latency leg).
- **8c:** Dockerfile(s), worker service, Fly/Railway deploy, real secret provisioning, `reg_worker` role.
- **8d:** manager/trainee demo UI + public URL.
- Branch-protection settings, `npm audit fix` (dev-only vite/launch-editor advisories), caching beyond npm.
- Matrix builds / multiple Node versions — single Node 22 is enough for one deploy target.
