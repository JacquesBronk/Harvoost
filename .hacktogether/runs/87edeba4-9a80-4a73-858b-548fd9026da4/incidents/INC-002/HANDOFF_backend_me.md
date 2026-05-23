---
phase: incidents/INC-002
agent: backend-dev
task: "GET /v1/auth/me must return display_name"
started: 2026-05-23
finished: 2026-05-23
status: complete
---

# Summary
Fixed the newly-surfaced INC-002 sub-bug: after Keycloak login the web `/timesheets`
shell crashed because `GET /v1/auth/me` did not return `display_name`, which the
frontend renders. The `/me` handler now SELECTs `display_name` from the `users` row
and returns it as part of the response, with a defensive fallback to `email` so the
contract is `display_name: string` (never null/undefined).

# Root detail
The `/me` handler did NOT load the user from the DB itself — it returned straight from
the `CurrentUserPayload` that `BearerAuthGuard` populates, and that payload only carries
`{ userId, email, roles }` (the guard's `lookupUser` selects email + roles only). So the
fix lives entirely in the `/me` handler: it now does its own `SELECT display_name FROM users`
keyed on the authenticated user id. I deliberately did NOT widen `CurrentUserPayload` or the
guard's `lookupUser` — that touches every authenticated route and is out of scope for this
hotfix.

# Files changed
- `apps/api/src/auth/auth.controller.ts` (modified) — `me()` is now `async`, runs a
  parameterized `SELECT display_name FROM users WHERE id = $1::bigint LIMIT 1` via the
  existing `this.prisma.$queryRawUnsafe` (matches the raw-SQL style used everywhere else in
  this controller), and returns `{ id, email, display_name, roles }`. Return type updated to
  `Promise<{ id: string; email: string; display_name: string; roles: string[] }>`.
- `apps/api/test/unit/auth-me.test.ts` (new) — 4 unit tests on `AuthController.me()`,
  following the existing controller-unit-test pattern in `cookie-auth.test.ts` /
  `oidc-callback.test.ts` (construct the controller directly with a prisma stub).

# OpenAPI spec
No edit was required. `/v1/auth/me` already references `MeResponse`, whose `user` is the
shared `User` schema, and `User` already lists `display_name: { type: string }` as a
**required** property (`.../03-api-design/openapi.yaml` lines ~2646 / 2657). The `/v1/auth/me`
200 example (lines ~277-287) already shows `display_name: Alice Example`. So the canonical
contract already documented `display_name`; this fix brings the implementation up to the spec.

# Final `/v1/auth/me` response shape
```json
{
  "id": "17",
  "email": "alice@harvoost.example.com",
  "display_name": "Alice Example",
  "roles": ["manager"]
}
```
(Note: the controller returns this flat shape, not the spec's `{ user, scope_meta }` envelope.
That envelope divergence is pre-existing and was left untouched — only `display_name` was added,
per the narrow task scope. The frontend-dev lane guards the consumer.)

# Null-handling choice
`users.display_name` is NOT NULL in the schema, but the handler is defensive: if the column
comes back null, blank, or whitespace-only — or the user row is somehow missing — it falls back
to `user.email`. This guarantees the contract is `display_name: string` (never null/undefined),
keeping the web shell simple (it can render `display_name` directly with no null guard).

# Test results
- `pnpm --filter @harvoost/api test` → **231 passed** (31 files), 0 failed. Includes the 4 new
  `auth-me.test.ts` cases (happy path + null/blank/missing-row fallbacks).
- Full `pnpm test` (all packages):
  - `@harvoost/db`: 21 passed
  - `@harvoost/jobs`: 40 passed
  - `@harvoost/shared`: 91 passed, **1 failed** — `RbacScopeService > throws RbacError on empty
    requesterId` (the SINGLE known, pre-existing baseline failure; unrelated to this change)
  - `@harvoost/api`: 231 passed
  - `@harvoost/web`: 21 passed
  - Net: only the known `RbacScopeService` failure remains; nothing else regressed.
- `pnpm --filter @harvoost/api run typecheck` (`tsc --noEmit`) → exit 0, clean.
- (`pnpm --filter @harvoost/api lint` fails to run due to a pre-existing ESLint v9 "no
  eslint.config.js" repo config gap — unrelated to this change, not introduced here.)

# What downstream agents need to know
- `GET /v1/auth/me` now returns `display_name: string` (guaranteed non-null/non-empty;
  falls back to `email`). Frontend may consume it without a null guard.
- The fix is localized to the `/me` handler. `CurrentUserPayload` and `BearerAuthGuard` were
  intentionally NOT changed, so no other authenticated route was affected.
- The OIDC callback response (`POST /v1/auth/oidc/callback`) still returns
  `user: { id, email, roles }` WITHOUT `display_name`. That handler was out of scope for this
  hotfix and was left untouched. If a future task wants parity, that handler already loads/upserts
  `display_name` and could add it cheaply — flagging as a possible follow-up, not done here.
- `apps/web/`, `packages/`, `infra/`, `.github/` were not touched.
```
