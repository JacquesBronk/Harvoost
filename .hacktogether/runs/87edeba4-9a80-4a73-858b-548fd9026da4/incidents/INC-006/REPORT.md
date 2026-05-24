# INC-006 — Admin › Users page crashes (`GET /v1/users` omits `roles`)

- **GitHub issue:** #7
- **Run:** 87edeba4-9a80-4a73-858b-548fd9026da4
- **Opened:** 2026-05-24
- **Severity:** High — `/admin/users` crashes into the React error boundary on load for any admin; the page exists specifically to view/edit roles.
- **Flow:** STREAMLINED directed hotfix. The diagnosis is certain (exact lines + the issue's own suggested fix), so the standalone debugger triage is skipped; live reproduction is folded into the verify-phase e2e. Both HITL gates kept.

## Symptom
`/admin/users` (as admin): the user-list fetch succeeds (`GET /v1/users` → 200 since #4's BigInt fix), then `TypeError: Cannot read properties of undefined (reading 'length')` inside an `Array.map` callback → route errors out.

## Root cause — frontend↔backend response-shape drift on `roles` (same class as #4)
- FE maps `user.roles.length` / `user.roles.map(...)` UNGUARDED at `apps/web/app/admin/users/page.tsx:282,285`, and seeds the role editor `new Set(user.roles)` at `:138,:314`. FE `User` type declares `roles: Role[]` REQUIRED (`apps/web/src/lib/api-types.ts:246`).
- BE `GET /v1/users` list (`apps/api/src/users/users.controller.ts:22`) `SELECT id, email, display_name, timezone, weekly_summary_opt_out, is_active, created_at` — **no roles** → every `user.roles` is `undefined` → `.length` throws.
- Inconsistent with `GET /v1/auth/me`, which DOES return `roles` (aggregated `SELECT role FROM user_roles WHERE user_id=$1` → `roleRows.map(r => String(r.role))`, auth.controller.ts:292,301).
- **Unmasked by #4:** `GET /v1/users` previously 500'd ("Do not know how to serialize a BigInt"), so the table never rendered. #4's `BigInt.prototype.toJSON` fix made it 200 → the rows now render and hit the missing-`roles` crash.

## Fix plan (matches the issue's suggestion)
1. **Backend (primary):** include `roles` in the `GET /v1/users` list response, aggregated from `user_roles` per user (mirror `/v1/auth/me`). Efficient aggregation (e.g. `array_agg`/`LEFT JOIN` in the list query — NO N+1), `String()`-mapped, matching the `User` schema. Role editor seeds from this (`draft: new Set(user.roles)`).
2. **Frontend (defensive):** guard the render — `(user.roles ?? []).length` / `(user.roles ?? []).map(...)` — so a missing field degrades gracefully instead of crashing the whole page.
3. **Spec + contract:** declare `roles` on the `GET /v1/users` list response in `openapi.yaml`, and extend the `@harvoost/contract` response-field check (from #4) to cover `GET /v1/users` so this field-level drift is caught at build.

## Acceptance criteria (from issue #7)
1. `/admin/users` loads and renders each user's roles without crashing.
2. `GET /v1/users` returns `roles` for each user (consistent with `GET /v1/auth/me`).
3. The role editor opens with the user's current roles pre-selected.
4. A contract/regression test fails if `GET /v1/users` drops a field the Users page reads.

## Scope guardrails
- No regress INC-001..005 / FEAT-001. No `.github/`. No real-Entra path. Reuse existing `user_roles` table (no migration).

## HITL gates
- **(a)** before fix dispatch.  **(b)** before push (`closes #7`).
