---
phase: 04-build
agent: backend-dev
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
INC-006 (issue #7) backend lane: `GET /v1/users` list omitted `roles`, so the
frontend `/admin/users` page crashed (`TypeError: Cannot read properties of
undefined (reading 'length')`) when mapping over `user.roles`. Fixed the list
handler in `apps/api/src/users/users.controller.ts` to aggregate each user's
roles from the `user_roles` table in a SINGLE query (no N+1) and project them as
a clean `string[]` per user — identical in shape to the `roles` array on
`GET /v1/auth/me`. A user with zero roles yields `roles: []` (never `null`,
never `[null]`). Pagination envelope, ordering, RBAC guard, and all other fields
are unchanged. Added a 6-test regression unit suite. No migration (table already
exists). Stayed inside `apps/api/*`; did not touch `openapi.yaml`,
`tests/contract`, or `apps/web`.

# Files touched
- apps/api/src/users/users.controller.ts (modified — `list()` handler only)
- apps/api/test/unit/users-list-roles.test.ts (new)

# Exact aggregation SQL used (single query, no N+1)
```sql
SELECT u.id, u.email, u.display_name, u.timezone, u.weekly_summary_opt_out, u.is_active, u.created_at,
       COALESCE(array_agg(ur.role) FILTER (WHERE ur.role IS NOT NULL), '{}') AS roles
FROM users u
LEFT JOIN user_roles ur ON ur.user_id = u.id
GROUP BY u.id
ORDER BY u.display_name LIMIT $1::int OFFSET $2::int
```
- `array_agg(...) FILTER (WHERE ur.role IS NOT NULL)` drops the NULL a LEFT JOIN
  produces for a roleless user (avoids `[null]`); `COALESCE(..., '{}')` turns the
  all-NULL group into an empty array.
- The handler then maps each row: `roles: Array.isArray(row.roles) ? row.roles.map((r) => String(r)) : []`
  — `String()`-mapped (mirroring `auth.controller.ts:301`) and defensively
  coerces any non-array driver result to `[]`.

# What downstream agents need to know
- PINNED CONTRACT delivered: each user object in `GET /v1/users` `.data[]` now
  has `roles: string[]` (role enum values; `[]` if none) — same shape as
  `GET /v1/auth/me`.roles. frontend-dev can seed the role editor from
  `user.roles` and api-designer can declare `roles` on the list response schema.
- DECISION (role enum values): `user_roles.role` is a TEXT column with
  `CHECK (role IN ('admin','finmgr','manager','employee'))` — NOT a Postgres
  enum type. The stored value for finance manager is `finmgr` (matches the
  controller's existing `RoleSchema` and `/v1/auth/me`), NOT `finance_manager`.
  The dispatch prompt mentioned `finance_manager` as a possibility; the actual
  stored/returned value is `finmgr`. Frontend `Role` type / contract should use
  the literal set `'admin' | 'finmgr' | 'manager' | 'employee'`.
- Only the `list()` handler changed; `getOne`, `assignRole`, `removeRole`,
  `updateUser`, and all `@Roles('admin')` guards are untouched.
- bigint `id` still serialized via the INC-004 `BigInt.prototype.toJSON`
  polyfill (unchanged) — `roles` is a plain `string[]` and is unaffected by it.

# Open questions / unknowns
- None. Live e2e reproduction of the `/admin/users` page render is folded into
  the verify phase per the REPORT's STREAMLINED flow.

# Verification evidence
- `pnpm --filter @harvoost/api typecheck` → clean (tsc --noEmit, no errors).
- `pnpm --filter @harvoost/api test` → 40 files, 310 tests, ALL PASSING
  (0 failures). Baseline was 304; +6 new tests in users-list-roles.test.ts =
  310. No pre-existing failures in this suite (the known `RbacScopeService` fail
  is in `@harvoost/shared`, not run here).
- New tests assert: multi-role user returns all roles as `string[]`; zero-roles
  user returns `[]` (asserts not null, not `[null]`); non-array driver result
  coerced to `[]`; `String()`-mapped values; single aggregation query (called
  exactly twice — list + COUNT, no per-user N+1); pagination envelope
  `{ data, page, page_size, total_count }` + offset preserved.
