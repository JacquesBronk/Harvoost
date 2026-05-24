---
phase: incidents/INC-009
agent: tester
started: 2026-05-24
finished: 2026-05-24
status: done
---

# Summary
Full-monorepo regression + verification of the INC-009 (GitHub #21) backend hotfix that added
`JOIN projects` (INNER) + `LEFT JOIN project_tasks` and returned `project_name` / `task_name`
from the time-entries `list()` and `running()` SELECTs. Ran all packages (contract, shared, db,
jobs, web, api unit + api real-DB e2e against the seeded dev Postgres). **No regressions** beyond
the 1 documented pre-existing `RbacScopeService` shared fail and 2 pre-existing `/v1/health`
api-e2e fails (both proven present at baseline HEAD with the hotfix stashed). The 4 new INC-009
assertions ran (NOT skipped — `dbReady` satisfied) and pass. Full report in `TEST_REPORT.md`.

# Files touched
- `.hacktogether/runs/.../incidents/INC-009/TEST_REPORT.md` (new — per-package counts, contract
  verdict, test-infra assessment)
- `.hacktogether/runs/.../incidents/INC-009/HANDOFF_test.md` (new — this file)
- No product or test code modified. (A transient `git stash`/`pop` of the two hotfix files was
  used to prove the `/v1/health` fails are pre-existing; files restored byte-identical.)

# What downstream agents need to know
- **CONTRACT DRIFT VERDICT: PASS — no drift, no `openapi.yaml` update required.** `@harvoost/contract`
  is 154/154 green; the added `project_name`/`task_name` response fields do not drift the
  contract. The suite is static (never runs the API), its response-shape check is one-directional
  (spec must declare what the FE reads — it never flags extra API response fields), and both
  `GET /v1/time-entries` and `GET /v1/time-entries/running` are NOT in `LOAD_BEARING` so their
  response schemas aren't field-checked at all. (Latent aside: `openapi.yaml` `TimeEntry` doesn't
  declare these two fields while the FE reads them — pre-dates INC-009, currently uncaught,
  optional follow-on only.)
- **Test-infra edits are test-file-only and sound.** `ENSURE_IDEMPOTENCY_TABLE` is a byte-identical
  copy of `IdempotencyService.TABLE_DDL`; `withSelfScope` stub matches the existing convention in
  `test/unit/time-entries-self-visibility.test.ts`. Neither touches product code. Full api suite
  green with them.
- **`idempotency_keys` migration gap (FLAGGED, not fixed):** the `idempotency_keys` TABLE is owned
  by no migration (absent from all `migration.sql`/`init.sql`/`seed.ts`); it exists only because
  `IdempotencyService` self-creates it lazily via `CREATE TABLE IF NOT EXISTS` on first
  idempotent write. Benign in prod (the running start-timer creates it before any bulk DELETE —
  confirmed the live DB now has the table after this run). For the test it is a test-DB-setup
  ordering artifact (cleanup DELETE runs before any service call). Optional db-lane follow-on:
  add a real migration so the table is schema-owned.
- **2 pre-existing api `test:e2e` fails surfaced (NOT INC-009):** `health.e2e.test.ts` and
  `security-headers.e2e.test.ts` both fail on `GET /v1/health` (`expected [200,503] to include
  500`) due to `BearerAuthGuard.canActivate` hitting an undefined `Reflector`
  (`getAllAndOverride`) in the full-AppModule e2e harness. Proven identical at baseline HEAD
  with the hotfix stashed. The backend HANDOFF only ran the time-entries e2e file in isolation,
  so it never exercised the full `test:e2e` suite and these were not previously visible. They are
  a latent e2e-harness wiring issue, candidate for a separate incident.

# Open questions / unknowns
- None blocking. Two optional follow-ons noted above (openapi `TimeEntry` fields; `idempotency_keys`
  migration) and one latent e2e-harness `/v1/health` Reflector bug — all OUT OF SCOPE for INC-009.

# Verification evidence
- `pnpm --filter @harvoost/contract test` → **154 passed / 154, 0 failed.** `GET /v1/time-entries`
  and `GET /v1/time-entries/running` both `spec✓ route✓`. Contract: no drift.
- `pnpm --filter @harvoost/shared test` → **101 passed / 1 failed** (the known
  `RbacScopeService > throws RbacError on empty requesterId`). = baseline.
- `pnpm --filter @harvoost/db test` (DATABASE_URL set) → **21 passed / 21.**
- `pnpm --filter @harvoost/jobs test` → **40 passed / 40.**
- `pnpm --filter @harvoost/web test` → **196 passed / 196** (incl. feat001-timer-wiring,
  feat002-list-envelope green — unaffected by added response fields).
- `DATABASE_URL=…@localhost:5432/harvoost… pnpm --filter @harvoost/api test` → **425 passed / 425.**
- `DATABASE_URL=… pnpm --filter @harvoost/api test:e2e` → **11 passed / 2 failed** (13). The 2
  fails are the pre-existing `/v1/health` ones; `time-entries-task-id.e2e.test.ts` is **7/7**
  including the 4 INC-009 assertions, no `[skip]` warnings (verbose run confirmed `dbReady`).
- Pre-existence proof: `git stash` of the 2 hotfix files → `test:e2e` reproduced the same 2
  `/v1/health` fails (`expected [200,503] to include 500`) → `git stash pop`, files verified
  byte-identical via `diff`.
- `pnpm --filter @harvoost/api typecheck` → **clean (tsc exit 0)** — validates the controller
  `src` change. (`nest build` NOT run — known broken; `pnpm lint` NOT run — known ESLint v9
  incompat. Both per dispatch: note, don't fix.)
- **Regressions: none** (beyond the 1 known shared fail + 2 pre-existing api-e2e `/v1/health`
  fails).

status: done
