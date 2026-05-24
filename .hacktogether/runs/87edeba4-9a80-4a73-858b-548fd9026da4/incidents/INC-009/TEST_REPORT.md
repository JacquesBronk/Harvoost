# INC-009 (GitHub #21) — Full-monorepo regression + verification

Backend hotfix under test: `apps/api/src/time-entries/time-entries.controller.ts` — `list()`
and `running()` SELECTs now `JOIN projects` (INNER) + `LEFT JOIN project_tasks` and return
`project_name` / `task_name`. Test extended in
`apps/api/test/e2e/time-entries-task-id.e2e.test.ts`. No frontend, no schema/migration change.

Verified against the seeded dev Postgres at `localhost:5432` (db `harvoost`, `harvoost`/`dev`),
real-DB e2e run with
`DATABASE_URL='postgresql://harvoost:dev@localhost:5432/harvoost?sslmode=disable'`.

---

## REGRESSIONS: NONE

(Beyond the 1 KNOWN pre-existing `RbacScopeService` empty-requesterId fail in `@harvoost/shared`,
and 2 PRE-EXISTING `/v1/health` e2e fails in `@harvoost/api` `test:e2e` — both proven present at
baseline HEAD with the hotfix stashed; see api section.)

---

## Per-package results

| Package            | Command                                   | Passed | Failed | Total | vs. baseline |
|--------------------|-------------------------------------------|--------|--------|-------|--------------|
| @harvoost/contract | `pnpm --filter @harvoost/contract test`   | 154    | 0      | 154   | = (~154) ✓   |
| @harvoost/shared   | `pnpm --filter @harvoost/shared test`     | 101    | 1*     | 102   | = (101 +1 known) ✓ |
| @harvoost/db       | `pnpm --filter @harvoost/db test`         | 21     | 0      | 21    | = (21) ✓     |
| @harvoost/jobs     | `pnpm --filter @harvoost/jobs test`       | 40     | 0      | 40    | = (40) ✓     |
| @harvoost/web      | `pnpm --filter @harvoost/web test`        | 196    | 0      | 196   | = (~196) ✓   |
| @harvoost/api      | `pnpm --filter @harvoost/api test` (unit) | 425    | 0      | 425   | = (~425) ✓   |
| @harvoost/api      | `pnpm --filter @harvoost/api test:e2e`    | 11     | 2†     | 13    | = (pre-existing fails) |

`*` shared fail = the documented pre-existing `RbacScopeService > throws RbacError on empty
requesterId` (`expected RbacError: requesterId is required to be an instance of RbacError`).
Acceptable per dispatch — NOT a regression.

`†` api `test:e2e` fails = `health.e2e.test.ts > returns a composite status object` and
`security-headers.e2e.test.ts > GET /v1/health passes the CSRF middleware`. Both fail with
`expected [200, 503] to include 500`. PROVEN pre-existing — see below. NOT a regression.

Totals (excluding the 1 known shared fail + 2 pre-existing api-e2e health fails):
**937 passed**, with the time-entries real-DB e2e (7/7) carrying the INC-009 assertions.

NOT run as gates (per dispatch — known-broken, NOTE-don't-fix):
- `nest build` — known broken repo-wide; substituted `pnpm --filter @harvoost/api typecheck`
  → **clean, tsc exit 0** (validates the controller `src` change; tsconfig excludes `test/`,
  so the test edits were validated by the passing vitest transpile+run).
- `pnpm lint` — known ESLint v9 incompat. Not run.

---

## CRITICAL — Contract drift verdict: PASS (no drift). No openapi update required.

`@harvoost/contract` (`tests/contract`) → **154 passed / 154, 0 failed.**

The added `project_name` / `task_name` response fields do **NOT** drift the contract. Verdict
is **definitive**, established two independent ways:

1. **Empirically:** the contract suite is GREEN. In its enumeration both modified endpoints
   resolve cleanly: `GET /v1/time-entries  spec✓ route✓` and
   `GET /v1/time-entries/running  spec✓ route✓`.

2. **By construction (why it cannot fail on this change):**
   - The contract test is **static** — it scans `apps/web` source for `apiFetch` calls and
     `apps/api/src` for routes, and reads the pinned `openapi.yaml`. It NEVER executes the API,
     so it never inspects the actual runtime response and cannot see extra response fields.
   - Its only response-shape assertion (`load-bearing endpoints … read-fields match the spec`)
     is **one-directional**: it asserts the spec *declares every field the FE reads*. It does
     NOT assert "the API response has no fields beyond the spec." Adding fields to the API
     response is therefore invisible to it.
   - Even that one-directional check runs only for endpoints in `LOAD_BEARING`
     (`tests/contract/src/contract-spec.ts`). **`GET /v1/time-entries` and
     `GET /v1/time-entries/running` are NOT in `LOAD_BEARING`** (time-entries only appears in
     `KNOWN_PARAM_DRIFT` for query keys), so their response schemas are not field-checked at all.

   Note for completeness: `openapi.yaml`'s `TimeEntry` schema (line 3778) does NOT declare
   `project_name` / `task_name`, and `apps/web/app/timesheets/page.tsx:268,270` reads
   `entry.project_name` / `entry.task_name`. This is a latent FE-reads-undeclared-field gap, but
   it is invisible to the current contract suite for the reasons above (these endpoints aren't
   `LOAD_BEARING`). It pre-dates INC-009 (the FE already read those fields with fallbacks before
   the hotfix). If a future change promotes `GET /v1/time-entries` into `LOAD_BEARING` with
   `project_name`/`task_name` in `reads`, the spec would then need them added as OPTIONAL fields.
   That is a possible follow-on hardening, NOT a current failure and NOT required by INC-009.

---

## Test-infra change assessment (the two edits in `time-entries-task-id.e2e.test.ts`)

The hotfix added two test-only fixtures to make the real-DB assertions execute:

(a) **Confined to the test file — CONFIRMED.** Neither edit touches product code.
   - `ENSURE_IDEMPOTENCY_TABLE` (`CREATE TABLE IF NOT EXISTS idempotency_keys …`) lives only in
     the test file. It is a verbatim copy of the service's own `TABLE_DDL`
     (`apps/api/src/common/idempotency/idempotency.service.ts:13-23`) — diffed, byte-identical
     column set. The only `CREATE TABLE … idempotency_keys` in `src/` is the service's own
     pre-existing DDL; the hotfix added none.
   - `withSelfScope` rbac stub lives only in the test's `makeRbac()`. The only `withSelfScope`
     in `src/` is the legitimate pre-existing call site
     (`time-entries.controller.ts:108`). The stub shape
     `(userId) => ({ userIds: [userId], selfOnly: true })` already matches the established
     convention in `test/unit/time-entries-self-visibility.test.ts:60,145`.

(b) **Full api suite green with them — CONFIRMED.** api unit `test` 425/425; api `test:e2e`
   time-entries file 7/7 (in both isolation and the full e2e run). The only api-e2e fails are
   the two unrelated pre-existing `/v1/health` ones.

(c) **`idempotency_keys`-missing condition — read: real-but-self-healing migration gap, benign
   in prod; for the test it is a test-DB-setup artifact.**
   - The `idempotency_keys` TABLE is owned by **no migration** — verified: it is absent from all
     of `packages/db/prisma/migrations/*/migration.sql`, `init.sql`, and `seed.ts` (the only
     `idempotency_*` hits in the db package are the `idempotency_key` *column* on a model and a
     comment, not the table). The table exists solely because `IdempotencyService.ensureTable()`
     runs `CREATE TABLE IF NOT EXISTS` lazily on the first `lookup`/`store`.
   - So strictly there IS a migration gap (no migration creates `idempotency_keys`). It is
     **benign in production**: the running app self-creates the table on the first idempotent
     write (start/switch/createManual), which is exactly why the live start-timer flow works.
     Confirmed empirically — after this run's controller `start()` calls, the live seeded DB now
     reports `to_regclass('public.idempotency_keys')` = `idempotency_keys` (it was created
     lazily by the service during the test).
   - For the e2e test the failure is a pure **test-DB-setup artifact**: the `beforeAll` cleanup
     `DELETE FROM idempotency_keys` runs BEFORE any service call, so on a freshly-seeded DB the
     table doesn't exist yet → `42P01`. The defensive `CREATE TABLE IF NOT EXISTS` mirrors the
     service DDL and removes the ordering hazard.
   - **FLAGGED, not fixed** (per dispatch). Possible future hardening: add an `idempotency_keys`
     migration to `@harvoost/db` so the table is schema-owned rather than app-lazily-created.
     Out of scope for INC-009.

---

## INC-009 assertions — ran (not skipped) and pass — CONFIRMED

Full `test:e2e` verbose run (DATABASE_URL set, `dbReady` satisfied, NO `[skip]` warnings emitted):

- `… (INC-009, #21) … > seeded task 1 is "General"` ✓
- `… (INC-009, #21) … > running() returns project_name + task_name after a start with a task` ✓
- `… (INC-009, #21) … > list() running row carries project_name + task_name` ✓
- `… (INC-009, #21) … > task_name is null when started with no task, project_name still populated` ✓

Plus the 3 pre-existing FEAT-001 task_id assertions in the same file — all green (7/7 file total).
These exercise the real `JOIN projects` / `LEFT JOIN project_tasks` against the seeded DB:
`project_name === <seeded project 1 name>`, `task_name === 'General'` with a task, and
`task_name === null` / `project_name` populated without a task.

---

## Pre-existing `/v1/health` e2e fails — proven NOT a regression

`health.e2e.test.ts` and `security-headers.e2e.test.ts` fail with
`expected [200, 503] to include 500`. Root cause (from the harness logs): in the full-AppModule
e2e harness, `BearerAuthGuard.canActivate` throws
`Cannot read properties of undefined (reading 'getAllAndOverride')` on `GET /v1/health` — the
`Reflector` is undefined in that harness wiring. This is wholly unrelated to the time-entries
SELECT change.

Proof of pre-existence: `git stash` of the two hotfix files (controller + e2e test) back to
HEAD, then re-running `test:e2e` reproduced the **identical 2 failures** with the identical
error. Hotfix files were then `stash pop`-restored and verified byte-identical to pre-stash.

Note: the backend HANDOFF reported the time-entries e2e file in isolation (7/7) and the unit
`test` script (425/425), so it never ran the full `test:e2e` suite and these 2 pre-existing
`/v1/health` fails were not previously surfaced. They are a latent e2e-harness issue, not
introduced here.

---

## Coverage gaps identified
- `openapi.yaml` `TimeEntry` does not declare `project_name`/`task_name` while the FE reads them;
  currently uncaught because `GET /v1/time-entries[/running]` are not `LOAD_BEARING`. Latent,
  pre-dates INC-009. (See contract verdict.) — optional follow-on.
- `idempotency_keys` table is not owned by a migration (app-lazily-created). — optional follow-on
  for the db lane.

## Production bugs found
- None attributable to INC-009. The 2 `/v1/health` e2e fails are a pre-existing e2e-harness
  Reflector wiring issue (not a product behavior path the FE/users hit), flagged for awareness.

## Notes
- The hotfix is additive to the SELECT projections only — zero schema/migration impact, reverts
  cleanly via `git checkout` of the two files.
- No code committed or pushed by this verification.
