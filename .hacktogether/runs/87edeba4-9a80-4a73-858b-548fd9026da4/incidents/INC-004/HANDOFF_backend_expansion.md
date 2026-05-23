---
phase: 04-build/backend
agent: backend-dev
started: 2026-05-23T16:18:00Z
finished: 2026-05-23T16:25:00Z
status: complete
---

# Summary
Implemented the 5 frontend-called-but-stubbed endpoints surfaced by the `@harvoost/contract`
test for INC-004 scope expansion. Four routes were added to `ProjectsController` (list/delete
members, list/delete managers) and one to `ClientsController` (delete with FK guard). All mirror
the existing controllers' RBAC (`@Roles('admin')`), raw parameterized SQL, `OffsetPaginated`
envelope, and `this.audit.record(...)` patterns. NO migration was needed — all three tables
(`project_members`, `project_managers`, `clients`) already have the required columns. The 4
project member/manager entries were removed from the `ALLOWED_PENDING` allowlist in
`openapi-contract.test.ts` (kept `GET /v1/clients/{client_id}`, still unimplemented).

# Files touched
- apps/api/src/projects/projects.controller.ts (modified) — added `Delete` import + 4 handlers: `listMembers`, `removeMember`, `listManagers`, `removeManager`
- apps/api/src/clients/clients.controller.ts (modified) — added `Delete` import + `ValidationFailedError` import + `remove` handler with 23503 FK guard
- apps/api/test/unit/openapi-contract.test.ts (modified) — removed 4 members/managers entries from `ALLOWED_PENDING`
- apps/api/test/unit/projects-members-managers.test.ts (new) — 8 tests (RBAC metadata + RolesGuard 403, paginated shapes, delete + audit)
- apps/api/test/unit/clients-delete.test.ts (new) — 6 tests (RBAC, delete + audit, FK guard → ValidationFailedError, no-audit-on-failure)

# What downstream agents need to know (for api-designer to match the spec)

## Routes added (all `@Roles('admin')`, all under `/v1`)
1. `GET  /v1/projects/{id}/members` → `OffsetPaginated<ProjectMember>`
2. `DELETE /v1/projects/{id}/members/{userId}` → `{ ok: true }` (FE reads `void`)
3. `GET  /v1/projects/{id}/managers` → `OffsetPaginated<ProjectManagerAnchor>`
4. `DELETE /v1/projects/{id}/managers/{managerId}` → `{ ok: true }` (FE reads `void`)
5. `DELETE /v1/clients/{id}` → `{ ok: true }` (FE reads `void`)

## Exact response shapes
- Envelope = `{ data: T[], page, page_size, total_count }` (matches `OffsetPaginated<T>` in `api-types.ts:210`). `total_count` comes from a `SELECT COUNT(*)::int`.
- `ProjectMember` data item: `{ id, project_id, user_id, user_display_name?, user_email?, joined_at, left_at }` — all IDs stringified (BigInt → String). `user_display_name`/`user_email` from a `JOIN users`; emitted as `undefined` when null. Matches `ProjectMember` (`api-types.ts:249`).
- `ProjectManagerAnchor` data item: `{ id, project_id, manager_id, manager_display_name?, manager_email?, assigned_at }` — IDs stringified, display fields from `JOIN users`. Matches `ProjectManagerAnchor` (`api-types.ts:259`).
- Both DELETE projects routes and the client DELETE return `{ ok: true }` (FE typed as `void`, so the body is ignored — spec can document `204`/empty or `{ok:true}`; FE doesn't care).

## Table columns used (confirmed against init migration `20260522000000_init` + schema.prisma)
- `project_members(id BIGSERIAL, project_id, user_id, joined_at DATE, left_at DATE)`. Partial unique index `(project_id, user_id) WHERE left_at IS NULL`. **GET filters `left_at IS NULL`** (active members only — mirrors what the existing POST's `ON CONFLICT` targets). **DELETE is a SOFT delete** (`SET left_at = CURRENT_DATE WHERE left_at IS NULL`) so the same user can be re-added later via the existing POST without colliding on the partial unique index.
- `project_managers(id BIGSERIAL, project_id, manager_id, assigned_at TIMESTAMPTZ)`, full unique `(project_id, manager_id)`. **DELETE is a HARD delete** (no soft-delete column exists).
- `clients(id, name, is_active, created_at, updated_at)`. **DELETE is a HARD delete.**

## FK-guard behavior (endpoint 5)
`projects.client_id REFERENCES clients(id) ON DELETE RESTRICT`, so deleting a client that still
has projects raises Postgres `23503` (foreign_key_violation). The handler catches it (by `.code`
and a message-regex fallback) and throws `ValidationFailedError('Cannot delete a client that
still has projects...', { code: 'CLIENT_HAS_PROJECTS' })`. This maps to **HTTP 400** with
envelope `{ code: 'VALIDATION_FAILED', message, details: { code: 'CLIENT_HAS_PROJECTS' } }` via
the global `HttpExceptionFilter` — NOT a raw 500. Audit is recorded on success only.

## RBAC decision
The client DELETE is `@Roles('admin')` only — NOT widened to `finmgr` even though sibling
client create/update are `@Roles('admin','finmgr')`. This honors the INC-004 hard requirement
"all 5 are `@Roles('admin')`... do NOT widen". Flagging in case product wants finmgr to delete
clients later (sibling mutations allow finmgr) — currently intentionally narrower.

## Confirmations
- NO migration added (existing tables sufficient).
- All 5 routes admin-only (`@Roles('admin')`).
- All 3 mutations (2 project DELETEs + client DELETE) record an audit entry: `project.member_remove`, `project.manager_remove`, `client.delete`.
- Did NOT touch `apps/web`, `openapi.yaml`, `tests/contract`, `.github/`, the realm, or OIDC. INC-001/002/003 + INC-004 round-1 untouched.

# Open questions / unknowns
- The repo-wide `pnpm lint` script is broken (ESLint v9 installed, no `eslint.config.js` flat config exists) — pre-existing, unrelated to this work, affects the whole repo. Lint was not part of the INC-004 verify gate (test + typecheck were). Code matches surrounding controller style exactly.
- Project DELETE member/manager are idempotent no-ops if the row is already gone (DELETE/UPDATE affecting 0 rows still 200 + audit). If the spec/FE wants a 404 for "member not found", that's a follow-up — current FE reads `void` and doesn't distinguish.

# Verification evidence
- `pnpm --filter @harvoost/api test` → 36 files, 273 tests, all PASS (includes the trimmed `openapi-contract.test.ts` + 14 new tests across the 2 new files).
- `pnpm --filter @harvoost/api typecheck` → clean (tsc --noEmit, no errors).
- Targeted run `vitest run projects-members-managers + clients-delete + openapi-contract` → 18 passed.
