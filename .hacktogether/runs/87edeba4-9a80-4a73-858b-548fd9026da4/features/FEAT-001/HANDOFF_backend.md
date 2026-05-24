---
phase: 04-build
agent: backend-dev
started: 2026-05-23
finished: 2026-05-23
status: complete
---

# Summary
Implemented the read-only `GET /v1/projects/{project_id}/tasks` endpoint (`operationId: listProjectTasks`) that was declared in the pinned `openapi.yaml` but had no controller (404 at runtime). The endpoint now exists as a registered NestJS route inside the existing `ProjectsController`, so the `@harvoost/contract` test resolves the FE task-picker path to BOTH a declared spec op AND a registered route. The route is project-visibility scoped, String()-maps bigint ids, supports the optional `is_active` boolean filter, and returns the `{ data: ProjectTask[] }` envelope exactly per the gate (a) decision #1 contract. No migration and no seed change were needed.

# Files touched
- `apps/api/src/projects/projects.controller.ts` (modified) — added `listTasks` handler + imported `ValidationFailedError`.
- `apps/api/test/unit/project-tasks-controller.test.ts` (new) — 10 unit tests covering shape, ids, filter, RBAC no-leak.

# Route signature + response shape shipped
- **Route:** `@Get(':project_id/tasks')` on `@Controller('v1/projects')` → `GET /v1/projects/:project_id/tasks` (contract scanner normalizes to `GET /v1/projects/{param}/tasks`, matching the spec path).
- **Handler:** `listTasks(@CurrentUser() user, @Param('project_id') projectId: string, @Query('is_active') isActive?: string)`.
- **Query:** optional `is_active`. `'true'`→filter `is_active = TRUE`, `'false'`→filter `is_active = FALSE`, absent→no filter (all tasks). Any other value → `ValidationFailedError` (422 on the wire).
- **Response:** `{ data: ProjectTask[] }` where each item is exactly
  `{ id: string, project_id: string, name: string, is_billable: boolean, is_active: boolean }`.
  `id` and `project_id` are explicitly `String()`-mapped from the raw `$queryRawUnsafe` rows (mirrors the INC-004 list endpoints so the shape is unambiguous regardless of the global `BigInt.prototype.toJSON`). Ordered `ORDER BY name ASC, id ASC` for stable output.
- **SQL:** parameterized `$queryRawUnsafe` (`$1::bigint` for project id, `$2::boolean` for the optional flag) — no string interpolation of values.

# RBAC approach
- Reused `RbacScopeService.getVisibleProjectIds(user.userId)` (the same mechanism the existing project GET routes use), NOT `assertCanSeeProject`.
  - **Why not `assertCanSeeProject`:** that method throws `RbacForbiddenError` (403), which leaks project existence. The pinned contract requires **404** when the requester cannot see the project. So I gate manually: if the scope is not `unrestricted` and `projectIds` does not include the requested id → `NotFoundError` (404), short-circuiting before any task SELECT runs (verified by test).
  - admin/finmgr (`unrestricted: true`) may list any project's tasks.
  - After the visibility gate, the handler confirms the project actually exists with a `SELECT id FROM projects ... LIMIT 1`; a missing project → 404 (covers the unrestricted path and a stale id for a scoped user, so an empty array never masks a typo'd/nonexistent id).
  - 401 (unauthenticated) is handled by the existing global guard — no change.

# Seed
- **No seed change.** `packages/db/prisma/seed.ts:148-162` already creates a default `General` task for **every** project in the RBAC fixture (idempotent findFirst-then-create). Alice (`alice@harvoost.local`, manager) can see P1 (she is its project_manager) and Bob's projects via her person-anchor; P1 has the `General` task, so the picker is demonstrably non-empty for the live Playwright demo. Nothing to add.

# What downstream agents need to know
- **404 (not 403) on no-visibility / nonexistent project** — by design per the pinned contract, to avoid existence leakage. This is a deliberate divergence from `getOne`'s `assertCanSeeProject` (403) behavior; the spec lists both 403 and 404 for this op, and gate (a) decision #1 pins 404.
- **`is_active` accepts only the literal strings `'true'`/`'false'`** (the spec declares it as `type: boolean`; query params arrive as strings). Other non-empty values are rejected with `VALIDATION_FAILED`. The FE picker should send `is_active=true` to list only active tasks.
- **`POST`/`PATCH` tasks remain unimplemented** (still spec'd, out of scope) — only the GET was built. No migration, no time-entries controller change.
- bigint ids are returned as **strings** — FE `ProjectTask` types must treat `id`/`project_id` as `string` (already noted in the pinned contract).

# Open questions / unknowns
- None.

# Verification evidence
- `pnpm --filter @harvoost/api test` → **38 files / 289 tests passed** (this is the apps/api package suite; my change added the new `project-tasks-controller.test.ts`). Before my change the package had 37 files; the run is fully green with 0 failures. (The "1 known pre-existing RbacScopeService failure" lives in the `@harvoost/shared` package, not apps/api, and was not touched.)
- `pnpm exec vitest run test/unit/project-tasks-controller.test.ts` → **10 passed** (new file: 200 shape + string ids, empty-array, ordering, is_active=true/false/absent, non-boolean reject, scoped 404 no-leak, scoped allow, nonexistent-project 404).
- `pnpm --filter @harvoost/api typecheck` (`tsc --noEmit`) → exit 0, clean.
- `pnpm --filter @harvoost/contract test` → **131 passed**; `GET /v1/projects/{param}/tasks` now reports `spec✓ route✓ q=[is_active]` (was previously a missing route).
- Did NOT run docker rebuild or the full monorepo suite (orchestrator handles end-to-end verify, per instructions).

---

# Addendum (2026-05-24) — time-entries non-null `task_id` 500 fix (GitHub #5)

## Summary
Live e2e on FEAT-001's new task picker surfaced a real HTTP 500 in the time-entries controller: three raw-SQL INSERTs bound `task_id` WITHOUT a `::bigint` cast while `project_id` WAS cast. With a non-null `task_id` (the picker sends a string id, e.g. `"1"`), Postgres read the parameter as `text` against the `bigint` `task_id` column → `42804: column "task_id" is of type bigint but expression is of type text` → 500. Latent since v0.1.0 because no UI ever sent `task_id` until the picker (`null::bigint` is valid, so the null-task path was unaffected). Fix: add `::bigint` to the `task_id` placeholder in all three INSERTs. Added a real-DB regression test that exercises a non-null `task_id` through start/switch/manual and is proven to fail against the unpatched code.

## The 3 casts (each was the 3rd positional placeholder `$3` → `$3::bigint`)
Confirmed by counting the column list of each INSERT — `task_id` is the 3rd column in all three (after `user_id`, `project_id`), so all three were `$3`. Only the `task_id` cast changed; column lists, other casts, RETURNING clauses, parameter bindings, RBAC, idempotency and transaction logic were left untouched (diff = 3 lines).

- **`start`** handler (`apps/api/src/time-entries/time-entries.controller.ts:175`):
  `VALUES ($1::bigint, $2::bigint, $3, …)` → `… $3::bigint, …` (columns: `user_id, project_id, task_id, notes, start_at, status, billable, mood_score, idempotency_key`).
- **`switch`** handler (`:256`):
  `VALUES ($1::bigint, $2::bigint, $3, …)` → `… $3::bigint, …` (columns: `user_id, project_id, task_id, notes, start_at, status, billable, idempotency_key` — `task_id` is `$3`, NOT a trap).
- **`createManual`** handler (`:324`):
  `VALUES ($1::bigint, $2::bigint, $3, $4, $5::timestamptz, $6::timestamptz, …)` → `… $3::bigint, …` (columns: `user_id, project_id, task_id, notes, start_at, end_at, status, billable`).

## Regression test
- **File:** `apps/api/test/e2e/time-entries-task-id.e2e.test.ts` (new, 3 tests).
- **Harness:** instantiates `TimeEntriesController` directly with a **real `PrismaClient`** (pointed at the seeded dev Postgres) + the real `IdempotencyService` + no-op rbac/audit/sync stubs — mirroring the construction in `test/unit/time-entries-controller.test.ts` but swapping the mocked Prisma stub for a live DB connection. It installs the same `BigInt.prototype.toJSON` polyfill as `apps/api/src/main.ts` (see `test/unit/bigint-json-serialization.test.ts`) so `IdempotencyService.store()`'s `JSON.stringify` doesn't throw on bigint columns. Uses seeded fixture user 7 (carol, employee + member of project 1) and project 1's seeded `General` task (id 1). Cleans `time_entries` + `idempotency_keys` for the test user before/after each case. Self-skips (with a warning) if the seeded fixture isn't reachable, so it never reports a misleading failure in a DB-less CI lane.
- **Cases (each asserts non-null `task_id` persists, and re-SELECTs the row to confirm):** `start` with `{project_id, task_id}` → running entry with `task_id` persisted; `switch` with `{project_id, task_id}` while a timer runs → running entry with the new `task_id`; manual `createManual` with `{project_id, task_id, start_at, end_at}` → draft entry with `task_id` persisted.
- **WHY it would have caught the bug (proven, not just claimed):** reverted all three casts and ran the test → all 3 cases failed with exactly `Raw query failed. Code: 42804 … column "task_id" is of type bigint but expression is of type text`. Restored the casts → all 3 pass. The mocked unit tests could NOT have caught this (their Prisma stub hard-codes `task_id: null` and never touches Postgres).

## Why an e2e-style direct-controller test (not a full supertest boot)
The full-AppModule supertest harness (used by `health.e2e.test.ts`) cannot connect Prisma under vitest: `PrismaService` does `require('@harvoost/db')`, which resolves to the package's TS source (`./src/index.ts`) and fails on an extensionless ESM import, so the app runs in DEGRADED mode and every DB-backed request throws before the cast even executes. Driving the controller directly with a real `PrismaClient` (resolvable from apps/api as a dep of `@harvoost/db`) is the reliable way to exercise the actual raw SQL against Postgres. File lives under `test/e2e/**` so it runs via `vitest.e2e.config.ts`, NOT the default unit config — the unit baseline is unchanged.

## Verification evidence (this addendum)
- `vitest run` (default unit config, `apps/api`) → **38 files / 289 passed, 0 failed** — unchanged from the FEAT-001 baseline (my new test is under `test/e2e/`, excluded from the unit config).
- `vitest run --config vitest.e2e.config.ts test/e2e/time-entries-task-id.e2e.test.ts` (real `DATABASE_URL`) → **3 passed**.
- Proof-of-catch: with the 3 casts reverted, the same 3 tests **failed** with `42804 … task_id is of type bigint but expression is of type text`; restored → green.
- `tsc --noEmit -p tsconfig.json` (`apps/api`) → exit 0, clean.
- Touched ONLY `apps/api/src/time-entries/time-entries.controller.ts` (3 casts) + the new test file. No migration, no schema/seed change, no other controller, no `apps/web`, no `.github/`, no OIDC/throttle change, no request-schema/response-shape change.

## What downstream agents need to know
- **Two pre-existing `apps/api` e2e FAILURES are NOT mine and NOT introduced by this change:** `health.e2e.test.ts` and `security-headers.e2e.test.ts` both assert `GET /v1/health ∈ [200,503]` but the health composite returns **500** in this sandbox. Proven independent: removing my test file entirely, the 2 failures persist; they fail identically with or without a real `DATABASE_URL`. Left untouched (out of scope). The full e2e file count is then 3 files / 9 tests → 7 pass (incl. my 3) + 2 pre-existing health failures.
- The repo-wide known failure `RbacScopeService > throws RbacError on empty requesterId` lives in `@harvoost/shared`, not apps/api — left as-is.
- `task_id` (like `id`/`project_id`) surfaces as a **string-serialized bigint** over HTTP via the global `BigInt.prototype.toJSON` polyfill in `main.ts`. FE already treats these as strings.
