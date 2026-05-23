# INC-004 — BigInt serialization fix (backend-dev)

## Summary

Fixed the pre-existing High bug where `GET /v1/users`, `GET /v1/projects` (list),
and `GET /v1/clients` (list) returned **500 "Do not know how to serialize a BigInt"**.
Those three older handlers return raw `prisma.$queryRawUnsafe` rows whose Postgres
`bigint` columns (`id`, `client_id`, `user_id`, …) surface as JS `BigInt`, and Nest
serializes responses via `JSON.stringify`, which cannot serialize `BigInt`.

The fix is a single global `BigInt.prototype.toJSON` serializer installed once at process
start in `apps/api/src/main.ts`. No controller was changed. This resolves the whole class
of bug (any current/future raw-row endpoint), and is harmless to the newer
`String()`-mapped endpoints (cost-rates, project members/managers) since a plain string
passes through `JSON.stringify` unchanged and never hits `BigInt.toJSON`.

## The exact edit — `apps/api/src/main.ts`

Inserted at top-level module scope, after the imports and immediately above
`async function bootstrap()` (so it's installed once, process-wide, before bootstrap runs):

```ts
// Postgres bigint columns surface as JS BigInt via $queryRaw; JSON.stringify cannot
// serialize BigInt. Render them as decimal strings (the API already returns string IDs
// everywhere else). Installed process-wide before bootstrap so it covers the older list
// endpoints (GET /v1/users, /v1/projects, /v1/clients) that return raw rows.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};
```

Behaviour: `JSON.stringify({ id: 123n })` → `{"id":"123"}` (decimal string). Large bigints
(> `Number.MAX_SAFE_INTEGER`) are preserved without precision loss (string render).

## Regression test added

`apps/api/test/unit/bigint-json-serialization.test.ts` (6 tests, all pass).

Note on placement: `main.ts` is the bootstrap entrypoint (it invokes `bootstrap()` on
import and is excluded from vitest coverage), and the repo's standard verified test command
`pnpm --filter @harvoost/api test` runs **only** `test/unit/**` + `src/**/*.test.ts` —
the live-DB e2e route harness (`test/e2e/**`) is a *separate* `test:e2e` command/config and
is not part of the verified suite or the 273-baseline. So per the dispatch's stated fallback
("at minimum a focused unit test that `JSON.stringify({ id: 123n })` works after the
serializer is installed"), the regression test installs the **identical** polyfill snippet
and asserts the serialization the three endpoints depend on, using the *exact raw-row shapes*
each list controller returns:

- Bare `JSON.stringify({ id: 123n })` does not throw (was: 500 "Do not know how to serialize a BigInt") and renders `"123"`.
- `GET /v1/users` raw row shape → `id` serializes as string `"42"`.
- `GET /v1/projects` raw row shape → both `id` (`"7"`) **and** `client_id` (`"3"`) serialize as strings.
- `GET /v1/clients` raw row shape → `id` serializes as string `"9"`.
- Large bigint (`9007199254740993n`) preserved without precision loss.
- Already-`String()`-mapped payloads pass through unchanged (proves the existing cost-rates / members / managers endpoints are unaffected).

Verified the test genuinely guards the regression: in a clean node process *without* the
polyfill, `JSON.stringify({ id: 123n })` throws `Do not know how to serialize a BigInt`
(reproduced the exact reported error).

## Verification (evidence)

- `pnpm --filter @harvoost/api test` → **279 passed (37 files)**, 0 failures
  (baseline was 273; +6 from the new test file).
- `pnpm --filter @harvoost/api typecheck` → **EXIT 0** (clean).
- Lint (`pnpm --filter @harvoost/api lint`) is broken repo-wide (ESLint v9 can't find an
  `eslint.config.*` file — fails before evaluating any source file). Pre-existing
  environment issue, unrelated to and not introduced by this change; out of scope.
- Confirmed no existing serialization expectations broke: the `String()`-mapped endpoints
  (cost-rates, project members/managers) still return strings, and their unit tests pass
  unchanged. The known repo-wide failure `RbacScopeService` in `@harvoost/shared` is in a
  different package and untouched.

## The three list endpoints now return 200

With the global serializer installed at process start, the `BigInt` `id`/`client_id`/`user_id`
columns in the raw rows returned by `UsersController.list`, `ProjectsController.list`, and
`ClientsController.list` now serialize as decimal strings instead of throwing — so the
responses are **200** (not 500), unblocking the `/admin/projects` + `/admin/clients` page
tables and the user-picker dropdowns.

## Scope adherence

- Touched ONLY `apps/api`: `src/main.ts` (the edit) + `test/unit/bigint-json-serialization.test.ts` (new).
- Did NOT touch any controller, `apps/web`, `openapi.yaml`, `tests/contract`, `.github/`, the realm, or the real-Entra-prod path.
- No new dependencies. No INC-001/002/003 or INC-004 round-1/expansion regressions.

## What downstream agents need to know

- API `bigint` IDs now consistently serialize as **decimal strings** across the whole API
  (the older list endpoints now match the convention the newer endpoints already followed).
  Frontend should continue treating all entity IDs as strings.
- Decision to record: the BigInt fix was implemented as a single global
  `BigInt.prototype.toJSON` polyfill in `main.ts` (process-wide, one place) rather than
  per-controller `String()` mapping — chosen because it resolves the entire class of bug
  including any future raw-row endpoint, and is a no-op for the already-string endpoints.
- The route-level (live-DB) e2e assertion was not added to the verified `test` suite because
  that command excludes `test/e2e/**` (separate `test:e2e` config requiring seeded DB rows
  and a real session); the focused unit regression mirrors the exact controller row shapes
  and reproduces/guards the original failure. If a seeded e2e DB harness is later wired into
  CI, a `supertest` route-level 200 check (`mintTestSession` admin/finmgr) would be a natural
  add — out of scope here.
```
