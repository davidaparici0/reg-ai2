# Phase 8a — CI + eval gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Actions pipeline that re-proves the suite on every PR + push to `main` (`tsc` + lint + test + build against a Postgres service) and runs the eval gate on `main`/manual when an OpenAI key is present.

**Architecture:** One workflow file (`.github/workflows/ci.yml`) with two jobs — `verify` (fast, always) and `eval` (key-gated to `main` + `workflow_dispatch`). Both spin up `pgvector/pgvector:pg16` as a service and run migrations as `reg` so CI exercises the same RLS as local. DB creds are the committed dev defaults (ephemeral CI db); the only secret is `OPENAI_API_KEY`.

**Tech Stack:** GitHub Actions, `actions/setup-node@v4` (Node 22), npm, Postgres 16 + pgvector service container, drizzle-kit migrate, vitest, Next build, the existing `eval:seed`/`eval:run` scripts.

**Spec:** `docs/superpowers/specs/2026-06-16-phase-8a-ci-eval-gate-design.md`

**Conventions (apply to every task):**
- Commits append the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Work on a `phase-8a-ci` branch cut from `main` (the design commit already lives on `main`). The execution sub-skill creates it.
- Docker Postgres must be up locally for the test/migrate steps (`docker compose up -d`).

---

## File Structure

**Create:**
- `.github/workflows/ci.yml` — the pipeline (jobs `verify` + `eval`).

**Modify:**
- `eslint.config.mjs` — allow `^_`-prefixed intentional unused bindings (so `_omit` is clean under `--max-warnings 0`).
- `test/api/ask.test.ts` — drop the unused `db` import.
- `test/lib/db.qaRls.test.ts` — drop the unused `and` import.
- `CLAUDE.md` — note Phase 8a complete (Task 3).

**No migration. No app/runtime code change** (only the lint config + two unused-import deletions).

---

## Task 1: Make lint a zero-warning gate

**Files:**
- Modify: `eslint.config.mjs`
- Modify: `test/api/ask.test.ts:16`
- Modify: `test/lib/db.qaRls.test.ts:2`

- [ ] **Step 1: Confirm the gate currently fails**

Run: `npm run lint -- --max-warnings 0`
Expected: **FAIL** (exit 1) — 3 warnings: `_omit` (src/lib/auth/types.ts), `db` (test/api/ask.test.ts), `and` (test/lib/db.qaRls.test.ts).

- [ ] **Step 2: Allow `^_` intentional unused bindings in the ESLint config**

Replace the body of `eslint.config.mjs` with (adds one rules override; keeps everything else):

```js
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Allow intentional unused bindings prefixed with _ (e.g. destructuring discards like
  // `const { passwordHash: _omit, ...pub } = user`). Lets CI run lint with --max-warnings 0
  // without flagging deliberate omissions, while still catching accidental dead vars.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
```

- [ ] **Step 3: Delete the two genuinely-unused imports**

In `test/api/ask.test.ts:16`, change:
```ts
import { db, withTenant } from "@/lib/db";
```
to:
```ts
import { withTenant } from "@/lib/db";
```

In `test/lib/db.qaRls.test.ts:2`, change:
```ts
import { and, eq } from "drizzle-orm";
```
to:
```ts
import { eq } from "drizzle-orm";
```

- [ ] **Step 4: Confirm the gate now passes**

Run: `npm run lint -- --max-warnings 0`
Expected: **PASS** (exit 0, no warnings).

- [ ] **Step 5: Confirm nothing else broke**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean; **179 tests pass** (the removed imports were unused, so behaviour is unchanged).

- [ ] **Step 6: Commit**

```bash
git add eslint.config.mjs test/api/ask.test.ts test/lib/db.qaRls.test.ts
git commit -m "Phase 8a: zero-warning lint gate (^_ ignore + drop 2 dead imports)"
```

---

## Task 2: Add the CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: reg
          POSTGRES_PASSWORD: reg_dev_pw
          POSTGRES_DB: reg_ai
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U reg -d reg_ai"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      MIGRATION_DATABASE_URL: postgres://reg:reg_dev_pw@localhost:5432/reg_ai
      DATABASE_URL: postgres://reg_app:reg_app_dev_pw@localhost:5432/reg_ai
      WORKER_DATABASE_URL: postgres://reg:reg_dev_pw@localhost:5432/reg_ai
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Apply migrations (extension + reg_app role + RLS)
        run: npm run db:migrate
      - name: Typecheck
        run: npx tsc --noEmit
      - name: Lint (no warnings allowed)
        run: npm run lint -- --max-warnings 0
      - name: Test
        run: npm test
      - name: Build
        run: npm run build

  eval:
    runs-on: ubuntu-latest
    needs: verify
    if: ${{ github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref == 'refs/heads/main') }}
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: reg
          POSTGRES_PASSWORD: reg_dev_pw
          POSTGRES_DB: reg_ai
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U reg -d reg_ai"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      MIGRATION_DATABASE_URL: postgres://reg:reg_dev_pw@localhost:5432/reg_ai
      DATABASE_URL: postgres://reg_app:reg_app_dev_pw@localhost:5432/reg_ai
      WORKER_DATABASE_URL: postgres://reg:reg_dev_pw@localhost:5432/reg_ai
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Apply migrations
        run: npm run db:migrate
      - name: Check for OpenAI key
        id: key
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: |
          if [ -n "$OPENAI_API_KEY" ]; then
            echo "present=true" >> "$GITHUB_OUTPUT"
          else
            echo "present=false" >> "$GITHUB_OUTPUT"
            echo "OPENAI_API_KEY not set — skipping eval (green)."
          fi
      - name: Seed eval corpus
        if: steps.key.outputs.present == 'true'
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: npm run eval:seed
      - name: Run eval gates
        if: steps.key.outputs.present == 'true'
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: npm run eval:run
```

- [ ] **Step 2: Sanity — run the verify job's commands locally**

With Docker Postgres up, run the exact sequence the `verify` job runs:
```bash
npm run db:migrate && npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm test && npm run build
```
Expected: all green (migrations apply or no-op, tsc clean, 0 warnings, 179 tests, build OK). This proves the workflow's commands; the YAML itself is validated by the first real run (Task 3).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "Phase 8a: CI workflow — verify (every PR + main) + key-gated eval (FR-027)"
```

---

## Task 3: Trigger the first run, verify, and configure GitHub (handoff — needs user authorization)

**Files:** none (operational). **Requires the user's go-ahead to push** — `main` is currently ahead of `origin/main` and the project has been merging locally, not pushing.

- [ ] **Step 1: Update `CLAUDE.md` status (still local)**

In `CLAUDE.md` "Build phases", change Phase 8 to reflect 8a shipped, e.g.:
```
- **Phase 8 — Tests, CI/CD, deploy.** ◀ CURRENT (8a CI+eval DONE; 8b obs · 8c deploy · 8d UI next). FR-024–025 + eval gate in CI; public demo URL.
```
Add a short `**Phase 8a — COMPLETE.**` note in "Current status" (CI workflow; verify on every PR + push to main; key-gated eval on main+dispatch; zero-warning lint gate; combined suite still 179 green). Commit:
```bash
git add CLAUDE.md
git commit -m "Phase 8a complete: CI + eval gate live (FR-027 eval-in-CI leg)"
```

- [ ] **Step 2: (USER-AUTHORIZED) Merge the branch to `main` and push**

After merging `phase-8a-ci` into `main` (via finishing-a-development-branch), and **only with the user's explicit go-ahead to push**:
```bash
git push origin main
```
This triggers `verify` (and `eval`, which skips green until the secret is set).

- [ ] **Step 3: Observe the run**

```bash
gh run list --branch main --limit 1
gh run watch    # or open the Actions tab
```
Expected: `verify` **green** (tsc + lint@0 + 179 tests + build); `eval` green-skipped (no key yet).

- [ ] **Step 4: (USER, manual on GitHub — one-time) Activate the eval gate + protect main**

- Add repo secret `OPENAI_API_KEY` (Settings → Secrets and variables → Actions). Re-run the `eval` job (or push to `main`) and confirm the four eval gates pass.
- Enable branch protection on `main` requiring the `verify` status check (Settings → Branches). This makes the gate enforced rather than informational.

**Definition of done:** `ci.yml` on `main`; a real run shows `verify` green; `eval` green (key set) or cleanly skipped; CLAUDE.md updated. Steps 2/4 require the user (push consent + GitHub settings).

---

## Self-Review checklist (run before handing off to execution)

- **Spec coverage:** `verify` job → Task 2 ✓ · `eval` key-gated job → Task 2 ✓ · zero-warning lint gate → Task 1 ✓ · Postgres service + migrate-as-reg + reg_app test creds → Task 2 (env block) ✓ · DoD "observe a real run" + branch-protection/secret follow-ups → Task 3 ✓ · "no app code change" → confirmed (only lint config + 2 dead imports). No migration — none added.
- **Env-var consistency:** `MIGRATION_DATABASE_URL` (reg) drives `db:migrate`; `DATABASE_URL` (reg_app) + `WORKER_DATABASE_URL` (reg) drive tests — matches `.env.example` and `drizzle.config.ts` exactly. `OPENAI_API_KEY` only in the `eval` job.
- **No placeholders:** every step has concrete commands / full file content / exact import edits.
- **Gotchas pinned:** secrets can't be used in a job-level `if:`, so the eval job gates its *steps* on a `steps.key.outputs.present` check; `verify` has no `if` (runs on every trigger); `eval` needs `verify` and is `if`-gated to main/dispatch.
